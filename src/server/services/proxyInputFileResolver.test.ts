import { beforeEach, describe, expect, it, vi } from 'vitest';

const getProxyFileByPublicIdForOwnerMock = vi.fn();

vi.mock('./proxyFileStore.js', () => ({
  getProxyFileByPublicIdForOwner: (...args: unknown[]) => getProxyFileByPublicIdForOwnerMock(...args),
  LOCAL_PROXY_FILE_ID_PREFIX: 'file-metapi-',
}));

describe('proxyInputFileResolver', () => {
  beforeEach(() => {
    getProxyFileByPublicIdForOwnerMock.mockReset();
  });

  it('preserves non-local file ids without resolving them from the local store', async () => {
    const { resolveResponsesBodyInputFiles } = await import('./proxyInputFileResolver.js');
    const body = {
      model: 'gpt-5',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_file',
              file_id: 'file_external_123',
            },
          ],
        },
      ],
    };

    await expect(resolveResponsesBodyInputFiles(
      body,
      { ownerType: 'global_proxy_token', ownerId: 'global' },
    )).resolves.toEqual(body);
    expect(getProxyFileByPublicIdForOwnerMock).not.toHaveBeenCalled();
  });

  it('resolves object-form responses input payloads with local file ids into inline-only uploads', async () => {
    getProxyFileByPublicIdForOwnerMock.mockResolvedValue({
      publicId: 'file-metapi-123',
      filename: 'brief.pdf',
      mimeType: 'application/pdf',
      contentBase64: Buffer.from('%PDF-local').toString('base64'),
    });

    const { resolveResponsesBodyInputFiles } = await import('./proxyInputFileResolver.js');
    await expect(resolveResponsesBodyInputFiles(
      {
        model: 'gpt-5',
        input: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_file',
              file_id: 'file-metapi-123',
            },
          ],
        },
      },
      { ownerType: 'managed_key', ownerId: '9' },
    )).resolves.toEqual({
      model: 'gpt-5',
      input: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_file',
            filename: 'brief.pdf',
            file_data: `data:application/pdf;base64,${Buffer.from('%PDF-local').toString('base64')}`,
          },
        ],
      },
    });
  });
});
