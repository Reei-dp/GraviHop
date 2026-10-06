export interface DecodedOAuthToken {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiryDateSeconds: number;
  isGcpTos: boolean;
}

export interface DecodedUserStatus {
  email: string;
  name: string;
  userTier?: string;
  profilePictureUrl?: string;
}

export class ProtobufHelper {
  public static encodeVarint(val: number): Buffer {
    const bytes: number[] = [];
    let v = Math.floor(val);
    while (v > 0x7f) {
      bytes.push((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    bytes.push(v & 0x7f);
    return Buffer.from(bytes);
  }

  public static decodeVarint(buf: Buffer, offset: number): { value: number; newOffset: number } {
    let result = 0;
    let shift = 0;
    let cur = offset;
    while (cur < buf.length) {
      const b = buf[cur++];
      result |= (b & 0x7f) << shift;
      if (!(b & 0x80)) {
        break;
      }
      shift += 7;
    }
    return { value: result, newOffset: cur };
  }

  public static encodeField(fieldNum: number, wireType: number, data: Buffer | number): Buffer {
    const tag = (fieldNum << 3) | wireType;
    const tagBuf = this.encodeVarint(tag);
    if (wireType === 0) {
      const valBuf = this.encodeVarint(data as number);
      return Buffer.concat([tagBuf, valBuf]);
    } else if (wireType === 2) {
      const payload = data as Buffer;
      const lenBuf = this.encodeVarint(payload.length);
      return Buffer.concat([tagBuf, lenBuf, payload]);
    }
    throw new Error(`Unsupported protobuf wire type: ${wireType}`);
  }

  /**
   * Decodes Base64 string from state.vscdb antigravityUnifiedStateSync.oauthToken
   */
  public static decodeOAuthToken(rawB64: string): DecodedOAuthToken | null {
    try {
      const outerBytes = Buffer.from(rawB64, 'base64');
      const text = outerBytes.toString('latin1');

      // The inner token is a base64 substring inside oauthTokenInfoSentinelKey
      const match = text.match(/([A-Za-z0-9_\-\.\:\/\@]{80,})/);
      if (!match) {
        return null;
      }

      const innerBytes = Buffer.from(match[1], 'base64');
      let accessToken = '';
      let refreshToken = '';
      let tokenType = 'Bearer';
      let expiryDateSeconds = 0;
      let isGcpTos = false;

      let i = 0;
      while (i < innerBytes.length) {
        const { value: tag, newOffset: nextOffset } = this.decodeVarint(innerBytes, i);
        i = nextOffset;
        const fieldNum = tag >> 3;
        const wireType = tag & 7;

        if (wireType === 0) {
          const { value: val, newOffset } = this.decodeVarint(innerBytes, i);
          i = newOffset;
          if (fieldNum === 5) {
            isGcpTos = val === 1;
          }
        } else if (wireType === 2) {
          const { value: length, newOffset } = this.decodeVarint(innerBytes, i);
          i = newOffset;
          const slice = innerBytes.subarray(i, i + length);
          i += length;

          if (fieldNum === 1) {
            accessToken = slice.toString('utf-8');
          } else if (fieldNum === 2) {
            tokenType = slice.toString('utf-8');
          } else if (fieldNum === 3) {
            refreshToken = slice.toString('utf-8');
          } else if (fieldNum === 4) {
            // submessage with expiry
            if (slice.length >= 2) {
              const { value: exp } = this.decodeVarint(slice, 1);
              expiryDateSeconds = exp;
            }
          }
        } else {
          break;
        }
      }

      if (!accessToken && !refreshToken) {
        // Fallback regex scan
        const yaMatch = innerBytes.toString('utf-8').match(/ya29\.[a-zA-Z0-9_\-]+/);
        const refMatch = innerBytes.toString('utf-8').match(/1\/\/[a-zA-Z0-9_\-]+/);
        if (yaMatch) { accessToken = yaMatch[0]; }
        if (refMatch) { refreshToken = refMatch[0]; }
      }

      return {
        accessToken,
        refreshToken,
        tokenType,
        expiryDateSeconds,
        isGcpTos,
      };
    } catch (err) {
      console.error('[GraviHop] Error decoding OAuthToken protobuf:', err);
      return null;
    }
  }

  /**
   * Re-encodes updated OAuth tokens into exact Base64 string for state.vscdb
   */
  public static encodeOAuthToken(params: {
    accessToken: string;
    refreshToken: string;
    expiryDateSeconds?: number;
    isGcpTos?: boolean;
    authStateJson?: string;
  }): string {
    const { accessToken, refreshToken } = params;
    const expiryDateSeconds = params.expiryDateSeconds || Math.floor(Date.now() / 1000) + 3600;
    const isGcpTos = params.isGcpTos ?? false;
    const authStateJson =
      params.authStateJson ||
      JSON.stringify({
        state: 'signedIn',
        context: {
          project: '',
          showProjectError: false,
          errorMessage: '',
          ineligibleMessage: '',
          verificationUrl: '',
          isGcpTos: false,
          browserOpenFailed: false,
          appealUrl: '',
          appealLinkText: '',
        },
      });

    // 1. Build inner message
    const f1 = this.encodeField(1, 2, Buffer.from(accessToken, 'utf-8'));
    const f2 = this.encodeField(2, 2, Buffer.from('Bearer', 'utf-8'));
    const f3 = this.encodeField(3, 2, Buffer.from(refreshToken, 'utf-8'));
    const f4Sub = this.encodeField(1, 0, expiryDateSeconds);
    const f4 = this.encodeField(4, 2, f4Sub);

    let innerPayload = Buffer.concat([f1, f2, f3, f4]);
    if (isGcpTos) {
      innerPayload = Buffer.concat([innerPayload, this.encodeField(5, 0, 1)]);
    }

    const innerB64 = innerPayload.toString('base64');

    // 2. Build Entry 1: authStateWithContextSentinelKey
    const e1ValSub = this.encodeField(1, 2, Buffer.from(authStateJson, 'utf-8'));
    const e1Sub = Buffer.concat([
      this.encodeField(1, 2, Buffer.from('authStateWithContextSentinelKey', 'utf-8')),
      this.encodeField(2, 2, e1ValSub),
    ]);
    const e1 = this.encodeField(1, 2, e1Sub);

    // 3. Build Entry 2: oauthTokenInfoSentinelKey
    const e2ValSub = this.encodeField(1, 2, Buffer.from(innerB64, 'utf-8'));
    const e2Sub = Buffer.concat([
      this.encodeField(1, 2, Buffer.from('oauthTokenInfoSentinelKey', 'utf-8')),
      this.encodeField(2, 2, e2ValSub),
    ]);
    const e2 = this.encodeField(1, 2, e2Sub);

    const fullBuffer = Buffer.concat([e1, e2]);
    return fullBuffer.toString('base64');
  }

  /**
   * Decodes Base64 string from state.vscdb antigravityUnifiedStateSync.userStatus
   */
  public static decodeUserStatus(rawB64: string): DecodedUserStatus {
    let email = '';
    let name = '';
    let userTier = 'standard-tier';
    let profilePictureUrl = '';

    try {
      const outerBytes = Buffer.from(rawB64, 'base64');
      const text = outerBytes.toString('utf-8');

      // Check inner base64 chunk
      const match = text.match(/([A-Za-z0-9_\-\.\:\/\@]{60,})/);
      const searchTarget = match ? Buffer.from(match[1], 'base64').toString('utf-8') : text;

      // Extract email
      const emailMatch = searchTarget.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      if (emailMatch) {
        email = emailMatch[0];
      }

      // Extract name (usually before email)
      const nameMatch = searchTarget.match(/\x1a\x04([^\x3a\x00-\x1f]+):/);
      if (nameMatch) {
        name = nameMatch[1];
      } else if (email) {
        name = email.split('@')[0];
      }

      // Check tier
      if (searchTarget.includes('free-tier')) {
        userTier = 'free-tier';
      } else if (searchTarget.includes('standard-tier')) {
        userTier = 'standard-tier';
      }

      // Check picture URL
      const picMatch = searchTarget.match(/https:\/\/lh3\.googleusercontent\.com\/[a-zA-Z0-9_\-]+/);
      if (picMatch) {
        profilePictureUrl = picMatch[0];
      }
    } catch (err) {
      console.error('[GraviHop] Error parsing userStatus:', err);
    }

    return {
      email,
      name: name || (email ? email.split('@')[0] : 'User'),
      userTier,
      profilePictureUrl,
    };
  }
}
