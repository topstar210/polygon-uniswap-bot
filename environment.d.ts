declare global {
    namespace NodeJS {
        interface ProcessEnv {
            ETHEREUM_RPC_URL: string;
            PRIVATE_KEY: string;
            FLASHBOTS_RELAY_SIGNING_KEY?: string;
            HEALTHCHECK_URL?: string;
            MINER_REWARD_PERCENTAGE: string;
            BUNDLE_EXECUTOR_ADDRESS: string;
        }
    }
}

// If this file has no import/export statements (i.e. is a script)
// convert it into a module by adding an empty export statement.
export { }