import { FunctionInvocationScope, BigNumberCoder, concat, arrayify, bn, hexlify, ZeroBytes32 } from 'fuels';
import type { AbstractContract, BN } from 'fuels';

// Session signing helper for set_session (owner wallet signs)
export function createCallToSign(
  nonce: number | string,
  chainId: number | string,
  invocationScope: FunctionInvocationScope<any>
): Uint8Array {
  const callConfig = invocationScope.getCallConfig();
  let argBytes = callConfig.func.encodeArguments(callConfig.args);
  const [option] = new BigNumberCoder('u64').decode(argBytes.slice(0, 8), 0);
  if (!option.isZero()) {
    argBytes = argBytes.slice(8 + 64);
  } else {
    argBytes = argBytes.slice(8);
  }
  const funcNameBytes = new TextEncoder().encode(callConfig.func.jsonFn.name);
  return arrayify(concat([
    new BigNumberCoder('u64').encode(bn(nonce.toString())),
    new BigNumberCoder('u64').encode(bn(chainId.toString())),
    new BigNumberCoder('u64').encode(funcNameBytes.length),
    funcNameBytes,
    argBytes,
  ]));
}

export const GAS_LIMIT_DEFAULT = bn('18446744073709551615');

export function getOption(args?: Uint8Array): Uint8Array {
  if (args) {
    return concat([new BigNumberCoder('u64').encode(1), args]);
  }
  return new BigNumberCoder('u64').encode(0);
}

export interface CallContractArg {
  contract_id: { bits: string };
  function_selector: Uint8Array;
  call_params: {
    coins: BN;
    asset_id: { bits: string };
    gas: BN;
  };
  call_data: Uint8Array | null;
}

export function encodeCallContractArg(arg: CallContractArg): Uint8Array {
  const contractIdBytes = arrayify(arg.contract_id.bits);
  const selectorBytes = arg.function_selector;
  const assetIdBytes = arrayify(arg.call_params.asset_id.bits);

  let callDataOption: Uint8Array;
  if (arg.call_data && arg.call_data.length > 0) {
    callDataOption = concat([
      new BigNumberCoder('u64').encode(1),
      new BigNumberCoder('u64').encode(arg.call_data.length),
      arg.call_data,
    ]);
  } else {
    callDataOption = new BigNumberCoder('u64').encode(0);
  }

  return concat([
    contractIdBytes,
    new BigNumberCoder('u64').encode(selectorBytes.length),
    selectorBytes,
    new BigNumberCoder('u64').encode(arg.call_params.coins),
    assetIdBytes,
    new BigNumberCoder('u64').encode(arg.call_params.gas),
    callDataOption,
  ]);
}

export function encodeSessionSigningPayload(nonce: BN, calls: CallContractArg[]): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(new BigNumberCoder('u64').encode(nonce));
  parts.push(new BigNumberCoder('u64').encode(calls.length));
  for (const call of calls) {
    parts.push(encodeCallContractArg(call));
  }
  return concat(parts);
}

export function createCallContractArg(invocationScope: FunctionInvocationScope<any>): {
  callContractArg: CallContractArg;
  variableOutputs: number;
} {
  const callConfig = invocationScope.getCallConfig();
  const forward = callConfig?.forward || { assetId: ZeroBytes32, amount: bn(0) };
  const variableOutputs = callConfig.txParameters?.variableOutputs || 0;
  const contract = callConfig.program as AbstractContract;
  const contractId = contract.id.toB256();
  const selectorBytes = callConfig.func.selectorBytes;
  const argBytes = callConfig.func.encodeArguments(callConfig.args);

  const callContractArg: CallContractArg = {
    contract_id: { bits: contractId },
    function_selector: selectorBytes,
    call_params: {
      coins: bn(forward.amount),
      asset_id: { bits: forward.assetId },
      gas: GAS_LIMIT_DEFAULT,
    },
    call_data: argBytes.length > 0 ? argBytes : null,
  };

  return { callContractArg, variableOutputs };
}
