import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { type Address, isAddress } from 'viem'
import { normalize } from 'viem/ens'
import {
  useAccount,
  useConnect,
  useDisconnect,
  useEnsAddress,
  useSendCalls,
} from 'wagmi'

import './App.css'
import {
  type EnsName,
  buildSetAddrCalls,
  buildTransferCall,
  fetchNames,
} from './ens'

const SUBGRAPH_URL = import.meta.env.VITE_SUBGRAPH_URL as string | undefined

function shorten(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function useDebounce<T>(value: T, delay = 500): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(id)
  }, [value, delay])
  return debounced
}

export default function App() {
  const { address: connectedAddress, isConnected } = useAccount()
  const { connectors, connect } = useConnect()
  const { disconnect } = useDisconnect()

  // When not connected, allow typing an address or ENS name to preview names.
  const [manualInput, setManualInput] = useState('')
  const debouncedInput = useDebounce(manualInput)
  const previewLooksLikeEns = !isConnected && debouncedInput.includes('.')
  const { data: previewEns, isLoading: previewResolving } = useEnsAddress({
    name: previewLooksLikeEns ? safeNormalize(debouncedInput) : undefined,
    query: { enabled: previewLooksLikeEns },
  })
  const previewAddress: Address | undefined = isConnected
    ? undefined
    : isAddress(debouncedInput)
      ? (debouncedInput as Address)
      : (previewEns ?? undefined)

  const owner = connectedAddress ?? previewAddress

  const namesQuery = useQuery({
    queryKey: ['names', owner],
    enabled: Boolean(owner && SUBGRAPH_URL),
    queryFn: () => fetchNames(SUBGRAPH_URL!, owner!),
  })

  return (
    <div className="app">
      <header>
        <div>
          <h1>Bulk Transfer ENS</h1>
          <p>Move all your ENS names in a single batched transaction.</p>
        </div>
        {isConnected ? (
          <button className="secondary" onClick={() => disconnect()}>
            {connectedAddress ? shorten(connectedAddress) : 'Disconnect'}
          </button>
        ) : (
          <div className="row">
            {connectors.map((c) => {
              if (c.id === 'injected') return null

              return (
                <button key={c.uid} onClick={() => connect({ connector: c })}>
                  {c.name}
                </button>
              )
            })}
          </div>
        )}
      </header>

      {!SUBGRAPH_URL && (
        <div className="card error">
          Missing <span className="mono">VITE_SUBGRAPH_URL</span>. Copy{' '}
          <span className="mono">.env.example</span> to{' '}
          <span className="mono">.env</span> and add your Graph API key.
        </div>
      )}

      {!isConnected && (
        <div className="card">
          <div className="field">
            <label htmlFor="addr">
              Preview an address{' '}
              <span className="hint">
                (read-only — connect a wallet to transfer)
              </span>
            </label>
            <input
              id="addr"
              placeholder="0x… address or name.eth"
              value={manualInput}
              onChange={(e) => setManualInput(e.target.value.trim())}
              spellCheck={false}
            />
            {previewLooksLikeEns && previewResolving && (
              <span className="hint">Resolving…</span>
            )}
            {previewLooksLikeEns && previewAddress && (
              <span className="hint mono">→ {previewAddress}</span>
            )}
            {previewLooksLikeEns && !previewResolving && !previewAddress && (
              <span className="hint">Could not resolve that name.</span>
            )}
          </div>
        </div>
      )}

      {!owner && (
        <p className="muted">
          Connect a wallet or enter an address to list its ENS names.
        </p>
      )}

      {owner && namesQuery.isLoading && <p className="muted">Loading names…</p>}

      {owner && namesQuery.error && (
        <div className="card error">{String(namesQuery.error)}</div>
      )}

      {owner && namesQuery.data && (
        <NamesPanel
          names={namesQuery.data}
          owner={owner}
          canTransfer={isConnected && owner === connectedAddress}
        />
      )}
    </div>
  )
}

function NamesPanel({
  names,
  owner,
  canTransfer,
}: {
  names: EnsName[]
  owner: Address
  canTransfer: boolean
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // Names whose ETH address record should also be set to the recipient.
  const [changeAddr, setChangeAddr] = useState<Set<string>>(new Set())
  const [recipient, setRecipient] = useState('')
  const debouncedRecipient = useDebounce(recipient)

  // Resolve an ENS name in the recipient field, otherwise use the raw address.
  const looksLikeEns = debouncedRecipient.includes('.')
  const { data: resolvedEns, isLoading: resolving } = useEnsAddress({
    name: looksLikeEns ? safeNormalize(debouncedRecipient) : undefined,
    query: { enabled: looksLikeEns },
  })
  const recipientAddress: Address | undefined = isAddress(debouncedRecipient)
    ? (debouncedRecipient as Address)
    : (resolvedEns ?? undefined)

  const { sendCalls, data, isPending, error, reset } = useSendCalls()

  // Selecting a name to transfer also opts it into an address change by
  // default (if it has a resolver); deselecting clears both.
  const toggle = (name: EnsName) => {
    const willSelect = !selected.has(name.id)
    setSelected((prev) => {
      const next = new Set(prev)
      willSelect ? next.add(name.id) : next.delete(name.id)
      return next
    })
    setChangeAddr((prev) => {
      const next = new Set(prev)
      if (willSelect && name.resolver) next.add(name.id)
      if (!willSelect) next.delete(name.id)
      return next
    })
  }

  const toggleAddr = (id: string) =>
    setChangeAddr((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const selectedNames = useMemo(
    () => names.filter((n) => selected.has(n.id)),
    [names, selected],
  )
  const addrNames = useMemo(
    () => names.filter((n) => n.resolver && changeAddr.has(n.id)),
    [names, changeAddr],
  )

  const onTransfer = () => {
    if (!recipientAddress) return
    reset()
    // Set address records first, while we still control the names, then hand
    // them over. Shared resolvers are collapsed into a single multicall.
    const calls = [
      ...buildSetAddrCalls(addrNames, recipientAddress),
      ...selectedNames.map((name) =>
        buildTransferCall(name, owner, recipientAddress),
      ),
    ]
    sendCalls({ calls })
  }

  if (names.length === 0) {
    return <p className="muted">No ENS names found for {shorten(owner)}.</p>
  }

  return (
    <>
      <div className="card">
        <div className="toolbar">
          <span className="count">
            {names.length} name{names.length === 1 ? '' : 's'} · {selected.size}{' '}
            selected
            {addrNames.length > 0 && ` · ${addrNames.length} addr`}
          </span>
        </div>

        <ul className="names">
          {names.map((name) => (
            <li key={name.id}>
              <label className="name-label">
                <input
                  type="checkbox"
                  checked={selected.has(name.id)}
                  onChange={() => toggle(name)}
                />
                <span>{displayName(name.name)}</span>
              </label>
              <span
                className={`badge ${name.kind}`}
                title={kindHint(name.kind)}
              >
                {kindLabel(name.kind)}
              </span>
              <label
                className="addr-toggle"
                title={
                  name.resolver
                    ? 'Also set this name’s ETH address to the recipient'
                    : 'No resolver set — address cannot be changed'
                }
              >
                <input
                  type="checkbox"
                  disabled={!name.resolver}
                  checked={changeAddr.has(name.id)}
                  onChange={() => toggleAddr(name.id)}
                />
                Change ETH address
              </label>
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <div className="field">
          <label htmlFor="recipient">Recipient</label>
          <input
            id="recipient"
            placeholder="0x… address or name.eth"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value.trim())}
            spellCheck={false}
          />
          {looksLikeEns && resolving && (
            <span className="hint">Resolving…</span>
          )}
          {looksLikeEns && recipientAddress && (
            <span className="hint mono">→ {recipientAddress}</span>
          )}
          {looksLikeEns && !resolving && !recipientAddress && (
            <span className="hint">Could not resolve that name.</span>
          )}
        </div>

        {!canTransfer && (
          <p className="muted">
            Connect the wallet that owns these names to transfer them.
          </p>
        )}

        {error && <div className="error">{prettyError(error)}</div>}
        {data && (
          <div className="success">
            Batch submitted. Call bundle id:{' '}
            <span className="mono">{String(data.id ?? data)}</span>
          </div>
        )}
      </div>

      <div className="sticky-action">
        <button
          disabled={
            !canTransfer ||
            !recipientAddress ||
            (selectedNames.length === 0 && addrNames.length === 0) ||
            isPending
          }
          onClick={onTransfer}
        >
          {isPending ? 'Confirm in wallet…' : submitLabel(selectedNames, addrNames)}
        </button>
      </div>
    </>
  )
}

// The subgraph renders unknown labels as their labelhash in brackets,
// e.g. "[09f5…5ff].katherine.eth". Show those as [unknown_subname].
function displayName(name: string): string {
  return name
    .split('.')
    .map((label) =>
      /^\[[0-9a-f]{64}\]$/.test(label) ? '[unknown_subname]' : label,
    )
    .join('.')
}

function submitLabel(transfers: EnsName[], addrUpdates: EnsName[]): string {
  const parts: string[] = []
  if (transfers.length > 0) {
    parts.push(`Transfer ${transfers.length} name${plural(transfers.length)}`)
  }
  if (addrUpdates.length > 0) {
    parts.push(
      `${transfers.length > 0 ? 'set' : 'Set'} ${addrUpdates.length} address${
        addrUpdates.length === 1 ? '' : 'es'
      }`,
    )
  }
  return parts.join(' & ') || 'Select names'
}

function plural(n: number) {
  return n === 1 ? '' : 's'
}

function safeNormalize(name: string): string | undefined {
  try {
    return normalize(name)
  } catch {
    return undefined
  }
}

function kindLabel(kind: EnsName['kind']) {
  if (kind === 'wrapped') return 'wrapped'
  if (kind === 'registrant') return '.eth'
  return 'subname'
}

function kindHint(kind: EnsName['kind']) {
  if (kind === 'wrapped')
    return 'Wrapped name — transferred via the NameWrapper'
  if (kind === 'registrant')
    return 'Unwrapped .eth registration — transferred via the BaseRegistrar'
  return 'Unwrapped subname — transferred via the ENS Registry'
}

function prettyError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error)
  return msg.split('\n')[0]
}
