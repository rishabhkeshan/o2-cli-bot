import { bn, hexlify, arrayify, Contract } from 'fuels';
import type { BN } from 'fuels';
import { EventEmitter } from 'events';
import { WalletManager } from './wallet.js';
import { FuelSessionSigner } from './session-signer.js';
import { encrypt, decrypt } from './encryption.js';
import type { EncryptedData } from './encryption.js';
import {
  createCallToSign,
  createCallContractArg,
  encodeSessionSigningPayload,
  GAS_LIMIT_DEFAULT,
  type CallContractArg,
} from './encoders.js';
import { O2RestClient } from '../api/rest-client.js';
import type { SessionAction, SessionActionsResponse } from '../types/api.js';
import type { Market } from '../types/market.js';

// Import the TradeAccount and OrderBook contract types
// These need to be copied from market-maker/backend/src/exchanges/o2-contracts/
// For now, we'll use dynamic contract loading with ABI JSON

export interface SessionInfo {
  sessionId: string;
  tradeAccountId: string;
  ownerAddress: string;
  contractIds: string[];
  expiry: number;
  createdAt: number;
}

export interface SessionManagerConfig {
  walletManager: WalletManager;
  restClient: O2RestClient;
  password: string;
  sessionExpiryMs: number;
}

export class SessionManager extends EventEmitter {
  private walletManager: WalletManager;
  private restClient: O2RestClient;
  private sessionSigner: FuelSessionSigner | null = null;
  private nonce: BN = bn(0);
  private tradeAccountId: string = '';
  private chainId: number = 0;
  private password: string;
  private sessionExpiryMs: number;
  private sessionInfo: SessionInfo | null = null;

  // Contract instances for ABI encoding
  private tradeAccountContract: any = null;
  private orderBookContracts: Map<string, Contract> = new Map();

  // OrderBook ABI (loaded at runtime)
  private orderBookAbi: any = null;

  // Action queue for nonce serialization
  private actionQueue: Promise<any> = Promise.resolve();

  // Session expiry monitoring
  private expiryCheckInterval: ReturnType<typeof setInterval> | null = null;
  private markets: Market[] = [];

  // Callbacks for persistence
  public onSessionCreated?: (info: SessionInfo, encryptedKey: EncryptedData) => Promise<void>;
  public onNonceUpdate?: (tradeAccountId: string, nonce: string) => Promise<void>;

  constructor(config: SessionManagerConfig) {
    super();
    this.walletManager = config.walletManager;
    this.restClient = config.restClient;
    this.password = config.password;
    this.sessionExpiryMs = config.sessionExpiryMs;
  }

  get ownerAddress(): string {
    return this.walletManager.ownerAddress;
  }

  get tradeAccount(): string {
    return this.tradeAccountId;
  }

  get currentNonce(): string {
    return this.nonce.toString();
  }

  get session(): SessionInfo | null {
    return this.sessionInfo;
  }

  async initialize(orderBookAbi: any): Promise<void> {
    this.orderBookAbi = orderBookAbi;
    this.chainId = await this.walletManager.getChainId();

    // Create or recover trade account
    this.tradeAccountId = await this.restClient.createTradingAccount(this.ownerAddress);

    // Import TradeAccount dynamically
    // We need the ABI for set_session encoding
    const { TradeAccount } = await import('../types/contracts/TradeAccount.js');
    this.tradeAccountContract = new TradeAccount(this.tradeAccountId, this.walletManager.provider);

    // Fetch current nonce
    await this.fetchNonce();
  }

  async restoreSession(
    sessionId: string,
    encryptedKey: EncryptedData,
    info: SessionInfo
  ): Promise<boolean> {
    try {
      // Check if session has expired
      if (Date.now() > info.expiry * 1000) {
        return false;
      }

      // Decrypt session key
      const privateKey = decrypt(
        encryptedKey.encryptedData,
        this.password,
        encryptedKey.salt,
        encryptedKey.iv
      );

      this.sessionSigner = new FuelSessionSigner(privateKey);
      this.sessionInfo = info;
      this.tradeAccountId = info.tradeAccountId;

      // Fetch current nonce
      await this.fetchNonce();

      return true;
    } catch {
      return false;
    }
  }

  async createNewSession(markets: Market[]): Promise<SessionInfo> {
    this.markets = markets;
    const contractIds = [this.tradeAccountId, ...markets.map((m) => m.contract_id)];
    const expiryInSeconds = Math.floor((Date.now() + this.sessionExpiryMs) / 1000);

    // Generate new session signer
    this.sessionSigner = new FuelSessionSigner();
    const sessionAddress = this.sessionSigner.address.toB256();

    // Build session input for set_session
    const session = {
      session_id: { Address: { bits: sessionAddress } },
      expiry: { unix: bn(expiryInSeconds) },
      contract_ids: contractIds.map((id) => ({ bits: id })),
    };

    // Create invocation scope and sign
    const invocationScope = this.tradeAccountContract.functions.set_session(undefined, session);
    const bytesToSign = createCallToSign(this.nonce.toString(), this.chainId, invocationScope);
    const signature = await this.walletManager.signMessage(bytesToSign);

    // Submit to API
    const sessionParams = {
      nonce: this.nonce.toString(),
      contract_id: this.tradeAccountId,
      contract_ids: contractIds,
      session_id: { Address: sessionAddress },
      signature: { Secp256k1: signature },
      expiry: bn(expiryInSeconds).toString(),
    };

    await this.restClient.createSession(sessionParams, this.ownerAddress);
    this.incrementNonce();

    // Verify nonce after session creation
    await this.fetchNonce();

    // Build session info
    this.sessionInfo = {
      sessionId: sessionAddress,
      tradeAccountId: this.tradeAccountId,
      ownerAddress: this.ownerAddress,
      contractIds: contractIds,
      expiry: expiryInSeconds,
      createdAt: Date.now(),
    };

    // Encrypt and persist session key
    const encryptedKey = encrypt(this.sessionSigner.privateKey, this.password);
    if (this.onSessionCreated) {
      await this.onSessionCreated(this.sessionInfo, encryptedKey);
    }

    return this.sessionInfo;
  }

  // Initialize OrderBook contract for a market (needed for action encoding)
  initMarketContract(market: Market): void {
    if (!this.orderBookContracts.has(market.market_id)) {
      const contract = new Contract(
        market.contract_id,
        this.orderBookAbi,
        this.walletManager.provider
      );
      this.orderBookContracts.set(market.market_id, contract);
    }
  }

  // Submit session actions (orders, cancels, settles)
  async submitActions(
    marketId: string,
    market: Market,
    actions: SessionAction[]
  ): Promise<SessionActionsResponse> {
    return this.enqueue(() => this.submitActionsImpl(marketId, market, actions, false));
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.actionQueue.then(fn, fn);
    this.actionQueue = run.then(() => {}, () => {});
    return run;
  }

  private async submitActionsImpl(
    marketId: string,
    market: Market,
    actions: SessionAction[],
    isRetry: boolean
  ): Promise<SessionActionsResponse> {
    if (!this.sessionSigner) {
      throw new Error('No active session. Call createNewSession() first.');
    }

    const orderBookContract = this.orderBookContracts.get(marketId);
    if (!orderBookContract) {
      throw new Error(`OrderBook contract not initialized for market ${marketId}`);
    }

    // Build CallContractArg array for each action
    const callContractArgs: CallContractArg[] = [];
    let totalVariableOutputs = 0;

    for (const action of actions) {
      let invocationScope: any;

      if (action.SettleBalance) {
        const to = action.SettleBalance.to;
        const identity = 'ContractId' in to
          ? { ContractId: { bits: (to as any).ContractId } }
          : { Address: { bits: (to as any).Address } };
        invocationScope = orderBookContract.functions.settle_balance(identity);
      } else if (action.CreateOrder) {
        const { side, price, quantity, order_type } = action.CreateOrder;
        let swayOrderType: any;
        switch (order_type) {
          case 'PostOnly': swayOrderType = { PostOnly: undefined }; break;
          case 'Limit': swayOrderType = { Limit: undefined }; break;
          case 'Spot': swayOrderType = { Spot: undefined }; break;
          case 'Market': swayOrderType = { Market: undefined }; break;
          case 'FillOrKill': swayOrderType = { FillOrKill: undefined }; break;
          default: swayOrderType = { Market: undefined };
        }

        const isBuy = side === 'Buy';
        const forwardAssetId = isBuy ? market.quote.asset : market.base.asset;
        const forwardAmount = isBuy
          ? bn(((BigInt(price) * BigInt(quantity)) / BigInt(10 ** market.base.decimals)).toString())
          : bn(quantity);

        invocationScope = orderBookContract.functions.create_order({
          price: bn(price),
          quantity: bn(quantity),
          order_type: swayOrderType,
        }).callParams({
          forward: {
            assetId: forwardAssetId,
            amount: forwardAmount,
          },
          gasLimit: GAS_LIMIT_DEFAULT,
        });
      } else if (action.CancelOrder) {
        invocationScope = orderBookContract.functions.cancel_order(action.CancelOrder.order_id);
      } else {
        continue;
      }

      const { callContractArg, variableOutputs } = createCallContractArg(invocationScope);
      callContractArgs.push(callContractArg);
      totalVariableOutputs += variableOutputs;
    }

    // Sign with session signer
    const bytesToSign = encodeSessionSigningPayload(this.nonce, callContractArgs);
    const sig = await this.sessionSigner.sign(arrayify(bytesToSign));

    const payload = {
      nonce: this.nonce.toString(),
      session_id: { Address: this.sessionSigner.address.toB256() },
      trade_account_id: this.tradeAccountId,
      signature: { Secp256k1: hexlify(Uint8Array.from(sig.Secp256k1.bits)) },
      actions: [{ market_id: marketId, actions }],
      variable_outputs: totalVariableOutputs,
      min_gas_limit: '20000000',
      collect_orders: true,
    };

    try {
      const resp = await this.restClient.submitSessionActions(payload, this.ownerAddress);
      this.incrementNonce();
      if (this.onNonceUpdate) {
        this.onNonceUpdate(this.tradeAccountId, this.nonce.toString()).catch(() => {});
      }
      return resp;
    } catch (err: any) {
      const errStr = JSON.stringify(err?.response?.data ?? err?.message ?? '');

      // Sync nonce from error response
      let nonceSynced = false;

      // 1. Parse on-chain nonce from IncrementNonceEvent (reverted transactions still increment)
      const incrementMatch = errStr.match(/IncrementNonceEvent\s*\{\s*nonce:\s*(\d+)\s*\}/);
      if (incrementMatch) {
        this.nonce = bn(incrementMatch[1]);
        nonceSynced = true;
      }

      // 2. Parse expected nonce from "less than the nonce in the database(N)" error
      if (!nonceSynced) {
        const dbNonceMatch = errStr.match(/nonce in the database\((\d+)\)/);
        if (dbNonceMatch) {
          this.nonce = bn(dbNonceMatch[1]);
          nonceSynced = true;
        }
      }

      // 3. Fallback: fetch nonce from API
      if (!nonceSynced) {
        await this.fetchNonce().catch(() => {});
      }

      // Retry once on nonce mismatch (nonce is now synced)
      if (!isRetry && (errStr.includes('nonce') || errStr.includes('Nonce')) && !errStr.includes('Invalid session')) {
        return this.submitActionsImpl(marketId, market, actions, true);
      }

      // Handle invalid session
      if (!isRetry && errStr.includes('Invalid session address')) {
        this.emit('sessionInvalid');
      }

      throw err;
    }
  }

  private async fetchNonce(): Promise<void> {
    try {
      const resp = await this.restClient.getAccount(this.tradeAccountId, this.ownerAddress);
      if (resp?.trade_account?.nonce !== undefined) {
        this.nonce = bn(resp.trade_account.nonce);
      }
    } catch (err) {
      console.error(`[SessionManager] Failed to fetch nonce:`, err);
    }
  }

  private incrementNonce(): void {
    this.nonce = this.nonce.add(bn(1));
  }

  /**
   * Start periodic session expiry check. Renews session automatically
   * when it's within 10% of its lifetime from expiry.
   */
  startExpiryMonitor(): void {
    if (this.expiryCheckInterval) return;
    // Check every 60 seconds
    this.expiryCheckInterval = setInterval(async () => {
      if (!this.sessionInfo) return;
      const now = Date.now();
      const expiryMs = this.sessionInfo.expiry * 1000;
      const remainingMs = expiryMs - now;
      const renewThresholdMs = this.sessionExpiryMs * 0.1; // renew when 10% lifetime remains

      if (remainingMs <= 0) {
        console.error('[SessionManager] Session has expired. Renewing...');
        await this.renewSession();
      } else if (remainingMs < renewThresholdMs) {
        console.log('[SessionManager] Session expiring soon. Renewing...');
        await this.renewSession();
      }
    }, 60_000);
  }

  private async renewSession(): Promise<void> {
    if (this.markets.length === 0) {
      console.error('[SessionManager] Cannot renew session: no markets stored');
      this.emit('sessionInvalid');
      return;
    }
    try {
      await this.createNewSession(this.markets);
      console.log('[SessionManager] Session renewed successfully');
    } catch (err) {
      console.error('[SessionManager] Failed to renew session:', err);
      this.emit('sessionInvalid');
    }
  }

  async shutdown(): Promise<void> {
    if (this.expiryCheckInterval) {
      clearInterval(this.expiryCheckInterval);
      this.expiryCheckInterval = null;
    }
    this.sessionSigner = null;
    this.sessionInfo = null;
  }
}
