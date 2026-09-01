export type Network = 'mainnet' | 'testnet'

export type NetworkConfig = {
  network: Network
  rpcUrl: string
  onaraUrl: string
  chainId: string
}

const NETWORKS: Record<Network, Omit<NetworkConfig, 'onaraUrl'>> = {
  mainnet: {
    network: 'mainnet',
    rpcUrl: 'https://fullnode.mainnet.sui.io:443',
    chainId: '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S',
  },
  testnet: {
    network: 'testnet',
    rpcUrl: 'https://fullnode.testnet.sui.io:443',
    chainId: '69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD',
  },
}

export function resolveNetworkConfig(
  network: Network,
  overrides: { rpcUrl?: string; onaraUrl: string },
): NetworkConfig {
  const defaults = NETWORKS[network]
  return {
    ...defaults,
    rpcUrl: overrides.rpcUrl ?? defaults.rpcUrl,
    onaraUrl: overrides.onaraUrl,
  }
}
