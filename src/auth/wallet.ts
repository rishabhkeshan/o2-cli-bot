import { Wallet, Provider, Signer, Address } from 'fuels';
import { ethers } from 'ethers';

export type WalletType = 'fuel' | 'evm';

function padEvmAddress(evmAddress: string): string {
  const clean = evmAddress.replace('0x', '').toLowerCase();
  return '0x' + '0'.repeat(24) + clean;
}

export class WalletManager {
  private fuelWallet: any = null;
  private evmWallet: ethers.Wallet | null = null;
  private _ownerAddress: string = '';
  private _walletType: WalletType;
  private _provider: any = null;

  constructor(privateKey: string, walletType: WalletType) {
    this._walletType = walletType;
    // Will be fully initialized in init()
    if (walletType === 'evm') {
      this.evmWallet = new ethers.Wallet(privateKey);
      this._ownerAddress = padEvmAddress(this.evmWallet.address);
    }
    // Fuel requires async provider init
    this._privateKey = privateKey;
  }

  private _privateKey: string;

  async init(networkUrl: string): Promise<void> {
    this._provider = new Provider(networkUrl);
    await this._provider.init();

    if (this._walletType === 'fuel') {
      this.fuelWallet = Wallet.fromPrivateKey(this._privateKey, this._provider);
      this._ownerAddress = this.fuelWallet.address.toB256();
    }
  }

  get ownerAddress(): string {
    return this._ownerAddress;
  }

  get walletType(): WalletType {
    return this._walletType;
  }

  get provider(): any {
    return this._provider;
  }

  async getChainId(): Promise<number> {
    return this._provider.getChainId();
  }

  async signMessage(bytesToSign: Uint8Array): Promise<string> {
    if (this._walletType === 'fuel') {
      return this.fuelWallet.signMessage({ personalSign: bytesToSign });
    } else {
      const sig = await this.evmWallet!.signMessage(bytesToSign);
      const parsed = ethers.Signature.from(sig);
      return parsed.compactSerialized;
    }
  }
}
