import { Signer, sha256, arrayify, Address } from 'fuels';

export class FuelSessionSigner {
  private signer: Signer;

  constructor(privateKey?: string) {
    this.signer = privateKey ? new Signer(privateKey) : new Signer(Signer.generatePrivateKey());
  }

  get address(): Address {
    return this.signer.address;
  }

  get privateKey(): string {
    return this.signer.privateKey;
  }

  async sign(data: Uint8Array): Promise<{ Secp256k1: { bits: number[] } }> {
    const signature = this.signer.sign(sha256(data));
    const bytes = Array.from(arrayify(signature));
    return { Secp256k1: { bits: bytes } };
  }
}
