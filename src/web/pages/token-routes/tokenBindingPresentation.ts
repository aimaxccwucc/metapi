export type TokenBindingOption = {
  id: number;
  name: string;
  isDefault: boolean;
  sourceModel?: string;
};

export type TokenBindingPresentation = {
  isFollowingAccountDefault: boolean;
  bindingModeLabel: string;
  effectiveTokenName: string;
  helperText: string;
  followOptionDescription: string;
};

export function getDefaultTokenOption(options: TokenBindingOption[]): TokenBindingOption | null {
  return options.find((option) => option.isDefault) || null;
}

export function describeTokenBinding(
  options: TokenBindingOption[],
  activeTokenId: number,
  fallbackTokenName?: string | null,
): TokenBindingPresentation {
  const defaultToken = getDefaultTokenOption(options);
  const selectedToken = activeTokenId
    ? options.find((option) => option.id === activeTokenId) || null
    : null;

  if (!activeTokenId) {
    const effectiveTokenName = defaultToken?.name || fallbackTokenName || '未设置默认令牌';
    return {
      isFollowingAccountDefault: true,
      bindingModeLabel: '跟随账号默认',
      effectiveTokenName,
      helperText: defaultToken
        ? `跟随账号默认。当前生效的是「${defaultToken.name}」，以后账号默认变化时会自动切换。`
        : '跟随账号默认。当前账号还没有默认令牌。',
      followOptionDescription: defaultToken
        ? `当前生效：${defaultToken.name}；以后账号默认变化时会自动切换`
        : '以后账号默认变化时会自动切换',
    };
  }

  const effectiveTokenName = selectedToken?.name || fallbackTokenName || `token-${activeTokenId}`;
  return {
    isFollowingAccountDefault: false,
    bindingModeLabel: '固定令牌',
    effectiveTokenName,
    helperText: selectedToken?.isDefault
      ? `已固定到「${effectiveTokenName}」。它目前也是账号默认，但以后账号默认变化时，这个通道不会跟着变。`
      : `已固定到「${effectiveTokenName}」，不会随账号默认变化。`,
    followOptionDescription: defaultToken
      ? `当前生效：${defaultToken.name}；以后账号默认变化时会自动切换`
      : '以后账号默认变化时会自动切换',
  };
}

export function buildFixedTokenOptionLabel(
  token: TokenBindingOption,
  options: {
    includeDefaultTag?: boolean;
    includeSourceModel?: boolean;
  } = {},
): string {
  let label = `固定使用：${token.name}`;
  if (options.includeDefaultTag && token.isDefault) {
    label += '（当前账号默认）';
  }
  if (options.includeSourceModel && token.sourceModel) {
    label += ` [${token.sourceModel}]`;
  }
  return label;
}

export function buildFixedTokenOptionDescription(token: TokenBindingOption): string {
  return token.isDefault
    ? '固定到这条令牌；它目前也是账号默认，但以后不会自动跟随'
    : '固定到这条令牌；不随账号默认变化';
}
