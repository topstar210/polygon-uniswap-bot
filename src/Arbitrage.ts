import * as _ from "lodash";
import { BigNumber, Contract, Wallet } from "ethers";
import { FlashbotsBundleProvider } from "@flashbots/ethers-provider-bundle";
import { MATIC_ADDRESS } from "./addresses";
import { EthMarket } from "./EthMarket";
import { MATIC, bigNumberToDecimal } from "./utils";

export interface CrossedMarketDetails {
  profit: BigNumber,
  volume: BigNumber,
  tokenAddress: string,
  buyFromMarket: EthMarket,
  sellToMarket: EthMarket,
}

export type MarketsByToken = { [tokenAddress: string]: Array<EthMarket> }

// TODO: implement binary search (assuming linear/exponential global maximum profitability)
const TEST_VOLUMES = [
  // MATIC.div(10),
  MATIC.div(6),
  MATIC.div(4),
  MATIC.div(2),
  MATIC.div(1),
  // MATIC.mul(2),
  // MATIC.mul(5),
  // MATIC.mul(10),
]

export function getBestCrossedMarket(crossedMarkets: Array<EthMarket>[], tokenAddress: string): CrossedMarketDetails | undefined {
  let bestCrossedMarket: CrossedMarketDetails | undefined = undefined;
  for (const crossedMarket of crossedMarkets) {
    const sellToMarket = crossedMarket[0]
    const buyFromMarket = crossedMarket[1]
    for (const size of TEST_VOLUMES) {
      const tokensOutFromBuyingSize = buyFromMarket.getTokensOut(MATIC_ADDRESS, tokenAddress, size);
      const proceedsFromSellingTokens = sellToMarket.getTokensOut(tokenAddress, MATIC_ADDRESS, tokensOutFromBuyingSize)
      const profit = proceedsFromSellingTokens.sub(size);
      if (bestCrossedMarket !== undefined && profit.lt(bestCrossedMarket.profit)) {
        // If the next size up lost value, meet halfway. TODO: replace with real binary search
        const trySize = size.add(bestCrossedMarket.volume).div(2)
        const tryTokensOutFromBuyingSize = buyFromMarket.getTokensOut(MATIC_ADDRESS, tokenAddress, trySize);
        const tryProceedsFromSellingTokens = sellToMarket.getTokensOut(tokenAddress, MATIC_ADDRESS, tryTokensOutFromBuyingSize)
        const tryProfit = tryProceedsFromSellingTokens.sub(trySize);
        if (tryProfit.gt(bestCrossedMarket.profit)) {
          bestCrossedMarket = {
            volume: trySize,
            profit: tryProfit,
            tokenAddress,
            sellToMarket,
            buyFromMarket
          }
        }
        break;
      }
      bestCrossedMarket = {
        volume: size,
        profit: profit,
        tokenAddress,
        sellToMarket,
        buyFromMarket
      }
    }
  }
  return bestCrossedMarket;
}

export class Arbitrage {
  private flashbotsProvider: FlashbotsBundleProvider;
  private bundleExecutorContract: Contract;
  private executorWallet: Wallet;

  constructor(executorWallet: Wallet, flashbotsProvider: FlashbotsBundleProvider, bundleExecutorContract: Contract) {
    this.executorWallet = executorWallet;
    this.flashbotsProvider = flashbotsProvider;
    this.bundleExecutorContract = bundleExecutorContract;
  }

  static printCrossedMarket(crossedMarket: CrossedMarketDetails): void {
    const buyTokens = crossedMarket.buyFromMarket.tokens
    const sellTokens = crossedMarket.sellToMarket.tokens
    console.log(
      `Profit: ${bigNumberToDecimal(crossedMarket.profit)} Volume: ${bigNumberToDecimal(crossedMarket.volume)}\n` +
      `${crossedMarket.buyFromMarket.protocol} (${crossedMarket.buyFromMarket.marketAddress})\n` +
      `  ${buyTokens[0]} => ${buyTokens[1]}\n` +
      `${crossedMarket.sellToMarket.protocol} (${crossedMarket.sellToMarket.marketAddress})\n` +
      `  ${sellTokens[0]} => ${sellTokens[1]}\n` +
      `\n`
    )
  }


  async evaluateMarkets(marketsByToken: MarketsByToken): Promise<Array<CrossedMarketDetails>> {
    const bestCrossedMarkets = new Array<CrossedMarketDetails>()

    for (const tokenAddress in marketsByToken) {
      const markets = marketsByToken[tokenAddress]
      const pricedMarkets = _.map(markets, (ethMarket: EthMarket) => {
        return {
          ethMarket: ethMarket,
          buyTokenPrice: ethMarket.getTokensIn(tokenAddress, MATIC_ADDRESS, MATIC.div(100)),
          sellTokenPrice: ethMarket.getTokensOut(MATIC_ADDRESS, tokenAddress, MATIC.div(100)),
        }
      });

      const crossedMarkets = new Array<Array<EthMarket>>()
      for (const pricedMarket of pricedMarkets) {
        _.forEach(pricedMarkets, pm => {
          if (pm.sellTokenPrice.gt(pricedMarket.buyTokenPrice)) {
            crossedMarkets.push([pricedMarket.ethMarket, pm.ethMarket])
          }
        })
      }

      const bestCrossedMarket = getBestCrossedMarket(crossedMarkets, tokenAddress);
      if (bestCrossedMarket !== undefined && bestCrossedMarket.profit.gt(MATIC.div(1000))) {
        bestCrossedMarkets.push(bestCrossedMarket)
      }
    }
    bestCrossedMarkets.sort((a, b) => a.profit.lt(b.profit) ? 1 : a.profit.gt(b.profit) ? -1 : 0)
    return bestCrossedMarkets
  }

  // TODO: take more than 1
  async takeCrossedMarkets(bestCrossedMarkets: CrossedMarketDetails[], blockNumber: number, minerRewardPercentage: number): Promise<void> {
    for (const bestCrossedMarket of bestCrossedMarkets) {
      console.log("Send this much Matic", bestCrossedMarket.volume.toString(), "get this much profit", bestCrossedMarket.profit.toString())
      const buyCalls = await bestCrossedMarket.buyFromMarket.sellTokensToNextMarket(MATIC_ADDRESS, bestCrossedMarket.volume, bestCrossedMarket.sellToMarket);
      const inter = bestCrossedMarket.buyFromMarket.getTokensOut(MATIC_ADDRESS, bestCrossedMarket.tokenAddress, bestCrossedMarket.volume);
      const sellCallData = await bestCrossedMarket.sellToMarket.sellTokens(bestCrossedMarket.tokenAddress, inter, this.bundleExecutorContract.address);
      
      const targets: Array<string> = [...buyCalls.targets, bestCrossedMarket.sellToMarket.marketAddress]
      const payloads: Array<string> = [...buyCalls.data, sellCallData]
      // console.log({targets, payloads})
      const minerReward = bestCrossedMarket.profit.mul(minerRewardPercentage).div(100);
      const transaction = await this.bundleExecutorContract.populateTransaction.uniswapMatic(bestCrossedMarket.volume, minerReward, targets, payloads, {
        gasPrice: BigNumber.from(0),
        gasLimit: BigNumber.from(1000000),
      });

      try {
        const estimateGas = await this.bundleExecutorContract.provider.estimateGas(
          {
            ...transaction,
            from: this.executorWallet.address
          })
        if (estimateGas.gt(1400000)) {
          console.log("EstimateGas succeeded, but suspiciously large: " + estimateGas.toString())
          continue
        }
        transaction.gasLimit = estimateGas.mul(2)
      } catch (e) {
        console.warn(`Estimate gas failure for ${JSON.stringify(bestCrossedMarket)}`)
        continue
      }
      const bundledTransactions = [
        {
          signer: this.executorWallet,
          transaction: transaction
        }
      ];
      const signedBundle = await this.flashbotsProvider.signBundle(bundledTransactions)
      const simulation = await this.flashbotsProvider.simulate(signedBundle, blockNumber + 1 )
      if ("error" in simulation || simulation.firstRevert !== undefined) {
        console.log(`Simulation Error on token ${bestCrossedMarket.tokenAddress}, skipping`)
        continue
      }
      console.log(`Submitting bundle, profit sent to miner: ${bigNumberToDecimal(simulation.coinbaseDiff)}, effective gas price: ${bigNumberToDecimal(simulation.coinbaseDiff.div(simulation.totalGasUsed), 9)} GWEI`)
      const bundlePromises =  _.map([blockNumber + 1, blockNumber + 2], targetBlockNumber =>
        this.flashbotsProvider.sendRawBundle(
          signedBundle,
          targetBlockNumber
        ))
      await Promise.all(bundlePromises)
      return
    }
    throw new Error("No arbitrage submitted to relay")
  }
}