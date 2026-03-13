import { describe, expect, it } from 'vitest';
import {
  buildFixedTokenOptionDescription,
  buildFixedTokenOptionLabel,
  describeTokenBinding,
} from './tokenBindingPresentation.js';

describe('tokenBindingPresentation', () => {
  it('describes follow-account-default mode with the current default token', () => {
    const result = describeTokenBinding([
      { id: 1, name: 'token-a', isDefault: true },
      { id: 2, name: 'token-b', isDefault: false },
    ], 0);

    expect(result.bindingModeLabel).toBe('跟随账号默认');
    expect(result.effectiveTokenName).toBe('token-a');
    expect(result.helperText).toContain('以后账号默认变化时会自动切换');
    expect(result.followOptionDescription).toContain('当前生效：token-a');
  });

  it('describes fixed mode when the selected token is also the account default', () => {
    const result = describeTokenBinding([
      { id: 1, name: 'default', isDefault: true },
      { id: 2, name: 'backup', isDefault: false },
    ], 1);

    expect(result.bindingModeLabel).toBe('固定令牌');
    expect(result.effectiveTokenName).toBe('default');
    expect(result.helperText).toContain('它目前也是账号默认');
    expect(result.helperText).toContain('不会跟着变');
  });

  it('describes fixed mode when the selected token is not the account default', () => {
    const result = describeTokenBinding([
      { id: 1, name: 'default', isDefault: true },
      { id: 2, name: 'backup', isDefault: false },
    ], 2);

    expect(result.bindingModeLabel).toBe('固定令牌');
    expect(result.effectiveTokenName).toBe('backup');
    expect(result.helperText).toContain('不会随账号默认变化');
  });

  it('describes follow-account-default mode when no default token exists yet', () => {
    const result = describeTokenBinding([
      { id: 2, name: 'backup', isDefault: false },
      { id: 3, name: 'spare', isDefault: false },
    ], 0);

    expect(result.bindingModeLabel).toBe('跟随账号默认');
    expect(result.effectiveTokenName).toBe('未设置默认令牌');
    expect(result.helperText).toContain('当前账号还没有默认令牌');
    expect(result.followOptionDescription).toContain('以后账号默认变化时会自动切换');
  });

  it('formats fixed token options with clearer labels and descriptions', () => {
    const token = {
      id: 3,
      name: 'shared-token',
      isDefault: true,
      sourceModel: 'gpt-4o-mini',
    };

    expect(buildFixedTokenOptionLabel(token, {
      includeDefaultTag: true,
      includeSourceModel: true,
    })).toBe('固定使用：shared-token（当前账号默认） [gpt-4o-mini]');
    expect(buildFixedTokenOptionDescription(token)).toContain('以后不会自动跟随');
  });
});
