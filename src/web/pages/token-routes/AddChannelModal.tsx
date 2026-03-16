import { useState, useMemo } from 'react';
import CenteredModal from '../../components/CenteredModal.js';
import ModernSelect from '../../components/ModernSelect.js';
import { api } from '../../api.js';
import { useToast } from '../../components/Toast.js';
import { tr } from '../../i18n.js';
import type { RouteCandidateView, RouteAccountOption, RouteTokenOption } from '../helpers/routeModelCandidatesIndex.js';
import type { RouteMissingTokenHint } from '../helpers/routeMissingTokenHints.js';
import {
  buildFixedTokenOptionDescription,
  buildFixedTokenOptionLabel,
  describeTokenBinding,
} from './tokenBindingPresentation.js';

type ChannelSelection = {
  accountId: number;
  tokenId?: number;
  sourceModel?: string;
};

type AddChannelModalProps = {
  open: boolean;
  onClose: () => void;
  routeId: number;
  routeTitle: string;
  candidateView: RouteCandidateView;
  onSuccess: () => void;
  missingTokenHints?: RouteMissingTokenHint[];
  onCreateTokenForMissing?: (accountId: number, modelName: string) => void;
  existingChannelAccountIds?: Set<number>;
};

export default function AddChannelModal({
  open,
  onClose,
  routeId,
  routeTitle,
  candidateView,
  onSuccess,
  missingTokenHints,
  onCreateTokenForMissing,
  existingChannelAccountIds,
}: AddChannelModalProps) {
  const toast = useToast();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedAccounts, setSelectedAccounts] = useState<Record<number, ChannelSelection>>({});
  const [submitting, setSubmitting] = useState(false);

  const missingAccounts = useMemo(() => {
    if (!missingTokenHints || missingTokenHints.length === 0) return [];
    const seen = new Map<number, { accountId: number; label: string; modelName: string }>();
    for (const hint of missingTokenHints) {
      for (const account of hint.accounts) {
        if (!seen.has(account.accountId)) {
          const label = `${account.username || `account-${account.accountId}`} @ ${account.siteName}`;
          seen.set(account.accountId, { accountId: account.accountId, label, modelName: hint.modelName });
        }
      }
    }
    return Array.from(seen.values());
  }, [missingTokenHints]);

  const filteredMissingAccounts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return missingAccounts;
    return missingAccounts.filter((item) => item.label.toLowerCase().includes(q));
  }, [missingAccounts, searchQuery]);

  const autoCreateMissingByAccountId = useMemo(() => {
    const next = new Map<number, { modelName: string }>();
    for (const item of missingAccounts) {
      if (!next.has(item.accountId)) {
        next.set(item.accountId, { modelName: item.modelName });
      }
    }
    return next;
  }, [missingAccounts]);

  const allSelectableAccounts = useMemo(() => {
    const next = new Map<number, RouteAccountOption>();
    for (const account of candidateView.accountOptions) {
      next.set(account.id, account);
    }
    for (const item of missingAccounts) {
      if (!next.has(item.accountId)) {
        next.set(item.accountId, {
          id: item.accountId,
          label: item.label,
        });
      }
    }
    return Array.from(next.values()).sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  }, [candidateView.accountOptions, missingAccounts]);

  const filteredSelectableAccounts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return allSelectableAccounts;
    return allSelectableAccounts.filter((option) => option.label.toLowerCase().includes(q));
  }, [allSelectableAccounts, searchQuery]);

  const selectableVisibleAccounts = filteredSelectableAccounts;

  const buildInitialSelection = (accountId: number): ChannelSelection => ({
    accountId,
    sourceModel: autoCreateMissingByAccountId.get(accountId)?.modelName
      || candidateView.tokenOptionsByAccountId[accountId]?.[0]?.sourceModel,
  });

  const selectedCount = Object.keys(selectedAccounts).length;
  const selectableVisibleIds = selectableVisibleAccounts.map((account) => account.id);
  const selectableVisibleSelectedCount = selectableVisibleIds.filter((accountId) => !!selectedAccounts[accountId]).length;
  const allVisibleSelected = selectableVisibleIds.length > 0 && selectableVisibleSelectedCount === selectableVisibleIds.length;

  const toggleAccount = (account: RouteAccountOption) => {
    setSelectedAccounts((prev) => {
      if (prev[account.id]) {
        const next = { ...prev };
        delete next[account.id];
        return next;
      }
      return {
        ...prev,
        [account.id]: buildInitialSelection(account.id),
      };
    });
  };

  const selectVisibleAccounts = () => {
    setSelectedAccounts((prev) => {
      const next = { ...prev };
      for (const account of selectableVisibleAccounts) {
        if (next[account.id]) continue;
        next[account.id] = buildInitialSelection(account.id);
      }
      return next;
    });
  };

  const clearVisibleAccounts = () => {
    setSelectedAccounts((prev) => {
      const next = { ...prev };
      for (const accountId of selectableVisibleIds) {
        delete next[accountId];
      }
      return next;
    });
  };

  const updateTokenForAccount = (accountId: number, tokenId: number, sourceModel: string) => {
    setSelectedAccounts((prev) => {
      if (!prev[accountId]) return prev;
      return {
        ...prev,
        [accountId]: {
          ...prev[accountId],
          tokenId: tokenId || undefined,
          sourceModel: sourceModel || undefined,
        },
      };
    });
  };

  const handleSubmit = async () => {
    const channels = Object.values(selectedAccounts);
    if (channels.length === 0) return;

    setSubmitting(true);
    try {
      const result = await api.batchAddChannels(routeId, channels);
      const msg = `已添加 ${result.created} 个通道` +
        (result.skipped > 0 ? `，跳过 ${result.skipped} 个重复` : '') +
        (result.errors.length > 0 ? `，${result.errors.length} 个错误` : '');
      toast.success(msg);
      setSelectedAccounts({});
      setSearchQuery('');
      onSuccess();
      onClose();
    } catch (e: any) {
      toast.error(e.message || '批量添加通道失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    if (!submitting) {
      setSelectedAccounts({});
      setSearchQuery('');
      onClose();
    }
  };

  return (
    <CenteredModal
      open={open}
      onClose={handleClose}
      title={`${tr('添加通道')} - ${routeTitle}`}
      maxWidth={560}
      footer={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
          <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
            {tr('已选')} {selectedCount} {tr('个通道')}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" onClick={handleClose} disabled={submitting}>
              {tr('取消')}
            </button>
            <button
              className="btn btn-primary"
              onClick={handleSubmit}
              disabled={submitting || selectedCount === 0}
            >
              {submitting ? (
                <><span className="spinner spinner-sm" /> {tr('添加中...')}</>
              ) : (
                `${tr('批量添加')} (${selectedCount})`
              )}
            </button>
          </div>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="toolbar-search" style={{ width: '100%' }}>
          <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={tr('搜索账号...')}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
            {tr('当前可批量选择')} {selectableVisibleAccounts.length} {tr('个账号')}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ fontSize: 12, padding: '6px 10px' }}
              onClick={allVisibleSelected ? clearVisibleAccounts : selectVisibleAccounts}
              disabled={submitting || selectableVisibleAccounts.length === 0}
            >
              {allVisibleSelected ? tr('清空当前结果') : tr('全选当前结果')}
            </button>
          </div>
        </div>

        <div style={{ maxHeight: 360, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {filteredSelectableAccounts.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--color-text-muted)', padding: '12px 0', textAlign: 'center' }}>
              {allSelectableAccounts.length === 0
                ? tr('当前没有可用的账号，请确认已有账号的令牌支持调用此模型')
                : tr('没有匹配的账号')}
            </div>
          ) : (
            <>
              {filteredSelectableAccounts.map((account) => {
                const isSelected = !!selectedAccounts[account.id];
                const tokens = candidateView.tokenOptionsByAccountId[account.id] || [];
                const selection = selectedAccounts[account.id];
                const missingHint = autoCreateMissingByAccountId.get(account.id) || null;
                const willAutoCreateToken = !!missingHint && tokens.length === 0;
                const isExisting = !!existingChannelAccountIds?.has(account.id);
                const tokenBinding = describeTokenBinding(tokens, selection?.tokenId || 0);

                return (
                  <div
                    key={account.id}
                    onClick={() => {
                      toggleAccount(account);
                    }}
                    style={{
                      padding: '8px 10px',
                      borderRadius: 'var(--radius-sm)',
                      border: `1px solid ${isSelected ? 'var(--color-primary)' : 'var(--color-border)'}`,
                      background: isSelected ? 'color-mix(in srgb, var(--color-primary) 6%, transparent)' : 'transparent',
                      cursor: 'pointer',
                      opacity: 1,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        readOnly
                        style={{ cursor: 'pointer', pointerEvents: 'none' }}
                      />
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{account.label}</span>
                      {isExisting ? (
                        <span className="badge badge-muted" style={{ fontSize: 10 }}>{tr('已添加')}</span>
                      ) : null}
                      {willAutoCreateToken ? (
                        <span className="badge badge-info" style={{ fontSize: 10 }}>{tr('自动创建Key')}</span>
                      ) : null}
                      {missingHint && onCreateTokenForMissing ? (
                        <button
                          type="button"
                          className="btn btn-link"
                          style={{ fontSize: 11, padding: '2px 6px' }}
                          onClick={(e) => {
                            e.stopPropagation();
                            onCreateTokenForMissing(account.id, missingHint.modelName);
                          }}
                        >
                          {tr('创建令牌')}
                        </button>
                      ) : null}
                    </div>

                    {willAutoCreateToken ? (
                      <div style={{ marginTop: 6, paddingLeft: 24, fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.4 }}>
                        {tr('当前账号缺少可用 key，提交后会先自动创建并刷新模型覆盖，再创建通道。')}
                      </div>
                    ) : null}

                    {isSelected && tokens.length > 0 && (
                      <div style={{ marginTop: 6, paddingLeft: 24 }} onClick={(e) => e.stopPropagation()}>
                        <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 4 }}>{tr('令牌绑定')}:</div>
                        <ModernSelect
                          size="sm"
                          value={(() => {
                            if (!selection?.tokenId) return '0';
                            return `${selection.tokenId}::${selection.sourceModel || ''}`;
                          })()}
                          onChange={(nextValue) => {
                            if (nextValue === '0') {
                              updateTokenForAccount(account.id, 0, selection?.sourceModel || '');
                              return;
                            }
                            const [tokenRaw, ...sourceParts] = nextValue.split('::');
                            updateTokenForAccount(account.id, Number.parseInt(tokenRaw, 10) || 0, sourceParts.join('::'));
                          }}
                          options={[
                            {
                              value: '0',
                              label: tr('跟随账号默认'),
                              description: tokenBinding.followOptionDescription,
                            },
                            ...tokens.map((token: RouteTokenOption) => ({
                              value: `${token.id}::${token.sourceModel || ''}`,
                              label: buildFixedTokenOptionLabel(token, {
                                includeDefaultTag: true,
                                includeSourceModel: true,
                              }),
                              description: buildFixedTokenOptionDescription(token),
                            })),
                          ]}
                          placeholder={tr('选择绑定方式')}
                        />
                        <div style={{ marginTop: 4, fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.4 }}>
                          {tokenBinding.helperText}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              {filteredMissingAccounts.length > 0 ? (
                <div style={{ borderTop: '1px dashed var(--color-border)', paddingTop: 8, marginTop: 4, fontSize: 12, color: 'var(--color-text-secondary)' }}>
                  {tr('缺少令牌的账号已支持直接勾选，提交时会自动创建可用 key。')}
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </CenteredModal>
  );
}
