import { getAddress } from "viem";

// Sources and verification notes: docs/technical-decisions.md.
export const BASE = {
  chainId: 8453 as const,
  factory: getAddress("0x33128a8fC17869897dcE68Ed026d694621f6FDfD"),
  positionManager: getAddress("0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1"),
  swapRouter: getAddress("0x2626664c2603336E57B271c5C0b26F421741e481"),
  quoter: getAddress("0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a"),
  aavePool: getAddress("0xA238Dd80C259a72e81d7e4664a9801593F98d1c5"),
  aaveDataProvider: getAddress("0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A"),
  weth: getAddress("0x4200000000000000000000000000000000000006"),
  usdc: getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
};
