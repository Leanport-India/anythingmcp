import axios from 'axios';
import { McpOAuthService } from './mcp-oauth.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('McpOAuthService', () => {
  let service: McpOAuthService;

  beforeEach(() => {
    service = new McpOAuthService();
    jest.clearAllMocks();
  });

  describe('exchangeCodeForTokens', () => {
    it('uses body credentials by default', async () => {
      mockedAxios.post.mockResolvedValue({
        data: {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
        },
      });

      await service.exchangeCodeForTokens({
        tokenUrl: 'https://auth.example.com/token',
        code: 'code-123',
        redirectUri: 'https://app.example.com/api/mcp-oauth/callback',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        codeVerifier: 'verifier',
      });

      const [_url, body, opts] = mockedAxios.post.mock.calls[0] as any;
      expect(body).toContain('client_id=client-id');
      expect(body).toContain('client_secret=client-secret');
      expect(opts.headers.Authorization).toBeUndefined();
    });

    it('uses HTTP Basic auth when tokenAuthMethod is client_secret_basic', async () => {
      mockedAxios.post.mockResolvedValue({
        data: {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
        },
      });

      await service.exchangeCodeForTokens({
        tokenUrl: 'https://sandbox-api.datev.de/token',
        code: 'code-123',
        redirectUri: 'https://app.example.com/api/mcp-oauth/callback',
        clientId: 'datev-client',
        clientSecret: 'secret:with space',
        tokenAuthMethod: 'client_secret_basic',
        codeVerifier: 'verifier',
      });

      const [_url, body, opts] = mockedAxios.post.mock.calls[0] as any;
      expect(body).toContain('grant_type=authorization_code');
      expect(body).toContain('code=code-123');
      expect(body).toContain('code_verifier=verifier');
      expect(body).not.toContain('client_id=');
      expect(body).not.toContain('client_secret=');
      expect(opts.headers.Authorization).toBe(
        `Basic ${Buffer.from('datev-client:secret%3Awith%20space').toString('base64')}`,
      );
    });
  });
});
