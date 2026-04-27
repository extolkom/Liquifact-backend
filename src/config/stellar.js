const config = require('./index');

/**
 * Get Stellar-specific configuration.
 * Ensures fail-fast behavior if config wasn't validated on boot.
 */
function getStellarConfig() {
  const { SOROBAN_RPC_URL, NETWORK_PASSPHRASE } = config.get();
  return {
    rpcUrl: SOROBAN_RPC_URL,
    networkPassphrase: NETWORK_PASSPHRASE,
  };
}

module.exports = { getStellarConfig };