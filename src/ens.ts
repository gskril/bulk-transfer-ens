import { type Address, type Hex, encodeFunctionData } from 'viem'

// Mainnet ENS contract addresses
export const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e' as const
export const BASE_REGISTRAR =
  '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85' as const
export const NAME_WRAPPER =
  '0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401' as const

const registrySetOwnerAbi = [
  {
    type: 'function',
    name: 'setOwner',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'owner', type: 'address' },
    ],
    outputs: [],
  },
] as const

const registrarTransferAbi = [
  {
    type: 'function',
    name: 'safeTransferFrom',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
    ],
    outputs: [],
  },
] as const

const wrapperTransferAbi = [
  {
    type: 'function',
    name: 'safeTransferFrom',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'id', type: 'uint256' },
      { name: 'amount', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [],
  },
] as const

const resolverSetAddrAbi = [
  {
    type: 'function',
    name: 'setAddr',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'a', type: 'address' },
    ],
    outputs: [],
  },
] as const

const resolverMulticallAbi = [
  {
    type: 'function',
    name: 'multicall',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'data', type: 'bytes[]' }],
    outputs: [{ name: 'results', type: 'bytes[]' }],
  },
] as const

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

// How a given name is held, which determines how it must be transferred.
export type TransferKind = 'wrapped' | 'registrant' | 'controller'

export interface EnsName {
  /** namehash of the full name (bytes32 hex) */
  id: Hex
  /** full name, e.g. "example.eth" or "sub.example.eth" */
  name: string
  /** labelhash of the leaf label (bytes32 hex), used for .eth registrations */
  labelhash: Hex
  kind: TransferKind
  /** resolver contract address, or null if no resolver is set */
  resolver: Address | null
}

interface RawDomain {
  id: Hex
  name: string | null
  labelhash: Hex | null
  resolver: { address: Hex | null } | null
}

// The Account entity buckets ownership into the three dimensions ENS actually
// tracks, so the bucket itself tells us how each name must be transferred:
//   registrations  -> registrant of an unwrapped .eth (BaseRegistrar NFT)
//   wrappedDomains -> owner of a wrapped name (NameWrapper ERC-1155)
//   domains        -> registry controller (unwrapped subnames)
//
// Expired names are filtered out by `$now`: an expired .eth registration leaves
// a stale registry `owner` behind, which would otherwise surface (mislabeled)
// in the `domains` bucket. Subnames have no expiry (null / 0) and are kept.
const NAMES_QUERY = /* GraphQL */ `
  query Names($id: ID!, $now: BigInt!) {
    account(id: $id) {
      registrations(first: 1000, where: { expiryDate_gt: $now }) {
        domain {
          ...DomainFields
        }
      }
      wrappedDomains(
        first: 1000
        where: { or: [{ expiryDate_gt: $now }, { expiryDate: "0" }] }
      ) {
        domain {
          ...DomainFields
        }
      }
      domains(
        first: 1000
        where: { or: [{ expiryDate: null }, { expiryDate_gt: $now }] }
      ) {
        ...DomainFields
      }
    }
  }
  fragment DomainFields on Domain {
    id
    name
    labelhash
    resolver {
      address
    }
  }
`

export async function fetchNames(
  subgraphUrl: string,
  owner: Address
): Promise<EnsName[]> {
  const res = await fetch(subgraphUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: NAMES_QUERY,
      variables: {
        id: owner.toLowerCase(),
        now: Math.floor(Date.now() / 1000).toString(),
      },
    }),
  })

  if (!res.ok) {
    throw new Error(`Subgraph request failed: ${res.status} ${res.statusText}`)
  }

  const json = (await res.json()) as {
    data?: {
      account: {
        registrations: { domain: RawDomain }[]
        wrappedDomains: { domain: RawDomain }[]
        domains: RawDomain[]
      } | null
    }
    errors?: { message: string }[]
  }

  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join('; '))
  }
  if (!json.data) throw new Error('No data returned from subgraph')

  const account = json.data.account
  // Process in priority order so a name held multiple ways (e.g. an unwrapped
  // .eth where the address is both registrant and controller) is transferred
  // the most complete way. First bucket to claim an id wins.
  const buckets: [TransferKind, RawDomain[]][] = [
    ['wrapped', account?.wrappedDomains.map((w) => w.domain) ?? []],
    ['registrant', account?.registrations.map((r) => r.domain) ?? []],
    ['controller', account?.domains ?? []],
  ]

  const byId = new Map<Hex, EnsName>()
  for (const [kind, domains] of buckets) {
    for (const domain of domains) {
      if (byId.has(domain.id)) continue
      if (!domain.name) continue
      // Reverse records (e.g. "<hash>.addr.reverse") aren't functional names.
      if (domain.name.endsWith('.addr.reverse')) continue
      // A direct .eth 2LD in the controller bucket means we're only the
      // registry manager, not the registrant — we own those records but can't
      // actually transfer the name. (If we were the registrant it would have
      // come through the higher-priority `registrant` bucket instead.)
      if (kind === 'controller' && /^[^.]+\.eth$/.test(domain.name)) continue
      const resolver = domain.resolver?.address
      byId.set(domain.id, {
        id: domain.id,
        name: domain.name,
        labelhash: domain.labelhash ?? '0x',
        kind,
        resolver:
          resolver && resolver !== ZERO_ADDRESS ? (resolver as Address) : null,
      })
    }
  }

  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export interface Call {
  to: Address
  data: Hex
}

/** Build the EIP-5792 call that transfers one name from `from` to `to`. */
export function buildTransferCall(
  name: EnsName,
  from: Address,
  to: Address
): Call {
  switch (name.kind) {
    case 'wrapped':
      return {
        to: NAME_WRAPPER,
        data: encodeFunctionData({
          abi: wrapperTransferAbi,
          functionName: 'safeTransferFrom',
          args: [from, to, BigInt(name.id), 1n, '0x'],
        }),
      }
    case 'registrant':
      return {
        to: BASE_REGISTRAR,
        data: encodeFunctionData({
          abi: registrarTransferAbi,
          functionName: 'safeTransferFrom',
          args: [from, to, BigInt(name.labelhash)],
        }),
      }
    case 'controller':
      return {
        to: ENS_REGISTRY,
        data: encodeFunctionData({
          abi: registrySetOwnerAbi,
          functionName: 'setOwner',
          args: [name.id, to],
        }),
      }
  }
}

/**
 * Build calls that point each name's ETH address record at `to`.
 *
 * Names that share a resolver are collapsed into a single `multicall` to that
 * resolver instead of one `setAddr` call each. Names without a resolver are
 * skipped (there's nothing to write to).
 */
export function buildSetAddrCalls(names: EnsName[], to: Address): Call[] {
  const byResolver = new Map<Address, EnsName[]>()
  for (const name of names) {
    if (!name.resolver) continue
    const group = byResolver.get(name.resolver)
    if (group) group.push(name)
    else byResolver.set(name.resolver, [name])
  }

  const calls: Call[] = []
  for (const [resolver, group] of byResolver) {
    if (group.length === 1) {
      calls.push({
        to: resolver,
        data: encodeFunctionData({
          abi: resolverSetAddrAbi,
          functionName: 'setAddr',
          args: [group[0].id, to],
        }),
      })
    } else {
      const inner = group.map((name) =>
        encodeFunctionData({
          abi: resolverSetAddrAbi,
          functionName: 'setAddr',
          args: [name.id, to],
        })
      )
      calls.push({
        to: resolver,
        data: encodeFunctionData({
          abi: resolverMulticallAbi,
          functionName: 'multicall',
          args: [inner],
        }),
      })
    }
  }
  return calls
}
