import { useEffect, useState } from 'react';
import type { GovernanceSummary, ModelConfigSnapshot } from '../../../src/ipc.js';
import { errorMessage, Empty, Loading, ErrorInline } from './common.js';

export function GovernanceView({
  openAudit
}: {
  openAudit: (filter: { runId?: string; actor?: string }) => void;
}) {
  const [gov, setGov] = useState<GovernanceSummary>();
  const [modelConfig, setModelConfig] = useState<ModelConfigSnapshot>();
  const [error, setError] = useState<string>();
  const [modelError, setModelError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([window.flowforge.getGovernance(), window.flowforge.getModelConfig()])
      .then(([nextGov, nextConfig]) => {
        setGov(nextGov);
        setModelConfig(nextConfig);
      })
      .catch((err) => setError(errorMessage(err)));
  }, []);

  const permissions = Object.entries(gov?.permissions ?? {});
  const ttlSeconds = gov?.session.ttlSeconds;
  const providerType = modelConfig?.provider.type ?? 'ollama';

  const saveModelConfig = async () => {
    if (!modelConfig) return;
    setSaving(true);
    setModelError(undefined);
    try {
      setModelConfig(await window.flowforge.updateModelConfig(modelConfig));
    } catch (err) {
      setModelError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const setProvider = (patch: Partial<NonNullable<ModelConfigSnapshot['provider']>>) => {
    setModelConfig((current) =>
      current
        ? {
            ...current,
            provider: { ...current.provider, ...patch }
          }
        : current
    );
  };

  return (
    <div>
      <h1 className="ff-page-title">Governance</h1>
      <p className="ff-page-sub">Identity providers, role mappings, permissions, model routing, session policy and per-user audit.</p>

      <ErrorInline error={error} />
      {!gov && !error && <Loading />}

      {gov && modelConfig && (
        <>
          <section className="ff-section">
            <h3>Model providers</h3>
            <div className="ff-card">
              <div className="ff-card-body">
                <p className="ff-muted" style={{ marginTop: 0 }}>
                  Configure provider routing here. API keys remain in environment variables or .env files.
                </p>
                <div className="ff-form-row">
                  <label>Provider</label>
                  <select
                    className="ff-select"
                    value={providerType}
                    onChange={(event) => setProvider({ type: event.target.value as ModelConfigSnapshot['provider']['type'] })}
                  >
                    <option value="ollama">Ollama</option>
                    <option value="deepseek">DeepSeek</option>
                    <option value="openai">OpenAI-compatible</option>
                    <option value="hybrid">Hybrid</option>
                  </select>
                </div>
                <div className="ff-form-row">
                  <label>Config file</label>
                  <span className="ff-monospace">{modelConfig.configPath ?? 'In-memory only'}</span>
                </div>
                {(providerType === 'ollama' || providerType === 'hybrid') && (
                  <>
                    <div className="ff-form-row">
                      <label>Ollama URL</label>
                      <input
                        className="ff-input"
                        value={modelConfig.provider.ollama?.url ?? ''}
                        onChange={(event) =>
                          setProvider({
                            ollama: {
                              url: event.target.value,
                              model: modelConfig.provider.ollama?.model ?? 'llama3.2',
                              embeddingModel: modelConfig.provider.ollama?.embeddingModel ?? 'nomic-embed-text'
                            }
                          })
                        }
                      />
                    </div>
                    <div className="ff-form-row">
                      <label>Default Ollama model</label>
                      <input
                        className="ff-input"
                        value={modelConfig.provider.ollama?.model ?? ''}
                        onChange={(event) =>
                          setProvider({
                            ollama: {
                              url: modelConfig.provider.ollama?.url ?? 'http://localhost:11434',
                              model: event.target.value,
                              embeddingModel: modelConfig.provider.ollama?.embeddingModel ?? 'nomic-embed-text'
                            }
                          })
                        }
                      />
                    </div>
                  </>
                )}
                {(providerType === 'deepseek' || providerType === 'openai' || providerType === 'hybrid') && (
                  <>
                    <div className="ff-form-row">
                      <label>Cloud base URL</label>
                      <input
                        className="ff-input"
                        value={modelConfig.provider.cloud?.baseUrl ?? ''}
                        onChange={(event) =>
                          setProvider({
                            cloud: {
                              baseUrl: event.target.value,
                              model: modelConfig.provider.cloud?.model ?? 'gpt-4o-mini'
                            }
                          })
                        }
                      />
                    </div>
                    <div className="ff-form-row">
                      <label>Cloud model</label>
                      <input
                        className="ff-input"
                        value={modelConfig.provider.cloud?.model ?? ''}
                        onChange={(event) =>
                          setProvider({
                            cloud: {
                              baseUrl: modelConfig.provider.cloud?.baseUrl ?? 'https://api.openai.com/v1',
                              model: event.target.value
                            }
                          })
                        }
                      />
                    </div>
                  </>
                )}
                {providerType === 'hybrid' && (
                  <>
                    {(['small', 'medium', 'large'] as const).map((tier) => (
                      <div key={tier} className="ff-form-row">
                        <label>{tier} tier</label>
                        <select
                          className="ff-select"
                          value={modelConfig.provider.hybrid?.[tier]?.type ?? 'ollama'}
                          onChange={(event) =>
                            setProvider({
                              hybrid: {
                                small: modelConfig.provider.hybrid?.small ?? { type: 'ollama', model: 'qwen2.5:3b' },
                                medium: modelConfig.provider.hybrid?.medium ?? { type: 'ollama', model: 'llama3.2' },
                                large: modelConfig.provider.hybrid?.large ?? { type: 'cloud', model: 'gpt-4o' },
                                [tier]: {
                                  type: event.target.value as 'ollama' | 'cloud',
                                  model: modelConfig.provider.hybrid?.[tier]?.model ?? ''
                                }
                              }
                            })
                          }
                        >
                          <option value="ollama">Ollama</option>
                          <option value="cloud">Cloud</option>
                        </select>
                        <input
                          className="ff-input"
                          value={modelConfig.provider.hybrid?.[tier]?.model ?? ''}
                          onChange={(event) =>
                            setProvider({
                              hybrid: {
                                small: modelConfig.provider.hybrid?.small ?? { type: 'ollama', model: 'qwen2.5:3b' },
                                medium: modelConfig.provider.hybrid?.medium ?? { type: 'ollama', model: 'llama3.2' },
                                large: modelConfig.provider.hybrid?.large ?? { type: 'cloud', model: 'gpt-4o' },
                                [tier]: {
                                  type: modelConfig.provider.hybrid?.[tier]?.type ?? 'ollama',
                                  model: event.target.value
                                }
                              }
                            })
                          }
                        />
                      </div>
                    ))}
                  </>
                )}
                <div className="ff-btn-row">
                  <button className="ff-btn primary" disabled={saving} onClick={() => void saveModelConfig()}>
                    Save model config
                  </button>
                </div>
                <ErrorInline error={modelError} />
              </div>
            </div>
          </section>

          <section className="ff-section">
            <h3>Identity providers</h3>
            <div className="ff-card">
              <div className="ff-card-body">
                {gov.providers.length === 0 && <Empty>No identity providers configured.</Empty>}
                {gov.providers.map((provider) => (
                  <span key={provider.id} className="ff-tag">
                    {provider.displayName ?? provider.id} ({provider.type})
                  </span>
                ))}
              </div>
            </div>
          </section>

          <section className="ff-section">
            <h3>Role mappings</h3>
            <div className="ff-card">
              <div className="ff-card-body" style={{ padding: 0, overflowX: 'auto' }}>
                {gov.roleMappings.length === 0 ? (
                  <p className="ff-muted" style={{ padding: 14 }}>
                    No role mappings configured.
                  </p>
                ) : (
                  <table className="ff-table">
                    <thead>
                      <tr>
                        <th>Claim</th>
                        <th>Value</th>
                        <th>Role</th>
                      </tr>
                    </thead>
                    <tbody>
                      {gov.roleMappings.map((mapping, index) => (
                        <tr key={`${mapping.claim}:${mapping.value}:${index}`}>
                          <td className="ff-monospace">{mapping.claim}</td>
                          <td className="ff-monospace">{mapping.value}</td>
                          <td>{mapping.role}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </section>

          <section className="ff-section">
            <h3>Permissions</h3>
            <div className="ff-card">
              <div className="ff-card-body" style={{ padding: 0, overflowX: 'auto' }}>
                {permissions.length === 0 ? (
                  <p className="ff-muted" style={{ padding: 14 }}>
                    No explicit permissions configured.
                  </p>
                ) : (
                  <table className="ff-table">
                    <thead>
                      <tr>
                        <th>Permission</th>
                        <th>Roles</th>
                      </tr>
                    </thead>
                    <tbody>
                      {permissions.map(([permission, roles]) => (
                        <tr key={permission}>
                          <td className="ff-monospace">{permission}</td>
                          <td>{roles.join(', ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </section>

          <section className="ff-section">
            <h3>Session policy</h3>
            <div className="ff-card">
              <div className="ff-card-body">
                <dl className="ff-kv">
                  <dt>Session TTL</dt>
                  <dd>
                    {ttlSeconds !== undefined
                      ? ttlSeconds >= 3600
                        ? `${(ttlSeconds / 3600).toFixed(1)} hours (${ttlSeconds}s)`
                        : `${ttlSeconds} seconds`
                      : '—'}
                  </dd>
                </dl>
              </div>
            </div>
          </section>

          <section className="ff-section">
            <h3>Per-user audit</h3>
            <div className="ff-card">
              <div className="ff-card-body" style={{ padding: 0, overflowX: 'auto' }}>
                {gov.userAudit.length === 0 ? (
                  <p className="ff-muted" style={{ padding: 14 }}>
                    No audited activity yet.
                  </p>
                ) : (
                  <table className="ff-table">
                    <thead>
                      <tr>
                        <th>Actor</th>
                        <th>Provider</th>
                        <th>Roles</th>
                        <th>Records</th>
                        <th>Last action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {gov.userAudit.map((row) => (
                        <tr key={row.actorId}>
                          <td>
                            <span
                              className="clickable"
                              onClick={() => openAudit({ actor: row.actorId })}
                              title="Open the audit trail pre-filtered to this actor"
                            >
                              {row.actorId}
                            </span>
                          </td>
                          <td>{row.provider ?? '—'}</td>
                          <td>{row.roles.join(', ') || '—'}</td>
                          <td>{row.recordCount}</td>
                          <td>{row.lastAction ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
