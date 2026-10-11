# Fix: BYOK Custom Provider Base URL Path Confusion + DeepSeek Anthropic Migration

## Problem 1: BYOK Base URL Path Confusion

When adding a custom Anthropic-compatible provider (BYOK) through the dashboard, operators often paste the full endpoint path into the Base URL field, causing connection test failures.

**Example problematic input:**
```
Base URL: https://api.deepseek.com/anthropic/v1/messages
```

**Result:** HTTP 404 on connection test and auto-fetch models.

## Problem 2: DeepSeek Currently Uses OpenAI Wire

Current implementation in Cartethyia uses OpenAI-compatible API for DeepSeek:
- Base URL: `https://api.deepseek.com`
- Wire family: `chat` (OpenAI-compatible)
- Auth: `Authorization: Bearer {key}`
- Endpoints: `/v1/chat/completions`, `/v1/responses`

**Goal:** Migrate DeepSeek to use Anthropic Messages wire instead:
- Base URL: `https://api.deepseek.com`
- Wire family: `messages` (Anthropic-compatible)
- Auth: `x-api-key: {key}`
- Endpoint: `/anthropic/v1/messages`

DeepSeek provides an Anthropic-compatible endpoint at `https://api.deepseek.com/anthropic/v1/messages` which works with standard Anthropic API format.

## Root Cause

The code in `src/providers/operations/byok-wire-profile.ts` derives the model discovery URL by:

1. `modelDiscoveryBaseUrl(baseUrl)` (lines 107-116):
   - Parses the base URL
   - If the pathname is empty or `/`, appends `/v1`
   - If the pathname already has a path segment, uses it as-is

2. `modelListUrl(baseUrl)` (lines 122-124):
   - Appends `/models` to the result from step 1

**With the problematic input:**
- Input: `https://api.deepseek.com/anthropic/v1/messages`
- Pathname: `/anthropic/v1/messages` (not empty)
- `modelDiscoveryBaseUrl` returns: `https://api.deepseek.com/anthropic/v1/messages`
- `modelListUrl` appends `/models`: `https://api.deepseek.com/anthropic/v1/messages/models`
- **Actual correct endpoint:** `https://api.deepseek.com/v1/models`

The code assumes Base URL is the host only (or host + version root), not the full endpoint path.

## Required Fix

### Fix 1: BYOK Base URL Validation (Both OpenAI and Anthropic wires)

**Option 1: Improve Dashboard UI (Recommended)**

Add validation and examples to the "Add Custom Provider" modal in the dashboard:

**Location:** `dashboard/src/features/providers/ProvidersPage.tsx` (search for `AddCompatibleModal` or similar)

**Changes needed:**
1. Add a helper text/placeholder under the Base URL field showing correct examples:
   ```
   Examples:
   - https://api.openai.com
   - https://api.deepseek.com
   - https://api.anthropic.com
   - https://your-custom-provider.com/v1
   ```

2. Add client-side validation to warn if the base URL contains endpoint paths like:
   - `/messages`
   - `/chat/completions`
   - `/v1/messages`
   - `/anthropic/v1/messages`

3. Strip common endpoint paths from the input if detected, or show a clear error message explaining the correct format.

**Option 2: Improve Server-Side URL Handling**

Update `src/providers/operations/byok-wire-profile.ts` to:

1. Detect common endpoint path patterns in the base URL
2. Strip them automatically with a warning in the connection test response
3. Or fail fast with a clear error message explaining the expected format

**Location:** `src/providers/operations/byok-wire-profile.ts`

**Changes needed:**
- In `modelDiscoveryBaseUrl()`, detect and strip known endpoint paths
- Or in `testByokConnection()` in `src/providers/discovery/probing-service.ts`, validate the base URL before attempting the request

**Option 3: Hybrid Approach (Best UX)**

- Dashboard: Show clear examples and validate on input
- Server: Defensive handling with helpful error messages

### Fix 2: Migrate DeepSeek to Anthropic Messages Wire

**Files to modify:**

1. **`src/providers/metadata.ts`** (line ~150):
   - Change `wireFamilyDefault` from `"chat"` to `"messages"`
   - Keep `baseUrl` as `"https://api.deepseek.com"`

2. **`src/providers/specs/configured-openai-providers.ts`**:
   - Remove `"deepseek"` from `GENERIC_API_KEY_PROVIDER_IDS` array (line ~20)
   - Remove `"deepseek"` from `GENERIC_API_KEY_SPECS` object (line ~42)
   - Create a new dedicated spec for DeepSeek in `src/providers/specs/deepseek.ts`:
     ```typescript
     export const DEEPSEEK_SPEC: ApiKeyProviderSpec = {
       provider_id: "deepseek",
       endpoint_paths_by_wire_family: {
         messages: "/anthropic/v1/messages",
       },
     };
     ```

3. **`src/providers/default-registry.ts`** (lines ~210-222):
   - Remove the current DeepSeek registration under `GENERIC_API_KEY_SPECS`
   - Register DeepSeek with its own Anthropic Messages spec:
     ```typescript
     deepseek: {
       ...configuredProvider(
         "deepseek",
         async () => (await import("./specs/deepseek")).DEEPSEEK_MODELS,
       ),
       loadAdapter: async () => {
         const { AnthropicApiKeyAdapter } = await import("../adapters/anthropic");
         return new AnthropicApiKeyAdapter();
       },
       loadModelDiscovery: anthropicModelDiscovery("deepseek", {
         baseUrl: "https://api.deepseek.com",
         endpointPath: "/anthropic/v1/messages",
       }),
     },
     ```

4. **Model discovery** - Ensure DeepSeek's `/v1/models` endpoint still works:
   - DeepSeek's model discovery endpoint is at `https://api.deepseek.com/v1/models`
   - This is separate from the Messages endpoint
   - The discovery fetcher should use the OpenAI-compatible `/v1/models` endpoint while the actual requests use `/anthropic/v1/messages`

## Testing

### Testing Fix 1: BYOK Base URL Validation

After implementing the validation fix, verify:

1. Connection test succeeds with correct base URL format:
   - `https://api.deepseek.com` → success
   - `https://api.deepseek.com/v1` → success

2. Connection test with problematic input either:
   - Auto-corrects the URL and succeeds with a warning, OR
   - Fails with a clear error message explaining the correct format

3. Auto-fetch models works correctly after fixing the base URL

### Testing Fix 2: DeepSeek Anthropic Migration

After migrating DeepSeek to Anthropic Messages wire, verify:

1. **Connection test:**
   - `POST https://api.deepseek.com/anthropic/v1/messages` with `x-api-key` header works
   - Request format matches Anthropic Messages API (messages array, max_tokens, etc.)

2. **Model discovery:**
   - `GET https://api.deepseek.com/v1/models` still returns model list
   - Models are correctly registered in the catalog

3. **Actual requests:**
   - Send a test request through the gateway to DeepSeek
   - Verify the request goes to `/anthropic/v1/messages` endpoint
   - Verify response is correctly parsed (streaming works, tool calls work, etc.)

4. **Capabilities:**
   - Tool calls work correctly
   - Reasoning/thinking content is preserved
   - Vision capabilities work (for `deepseek-v4.1-flash`)

5. **Backward compatibility:**
   - Existing DeepSeek accounts continue to work
   - No breaking changes to the API gateway interface

## Related Files

### Fix 1: BYOK Base URL Validation
- `src/providers/operations/byok-wire-profile.ts` - URL derivation logic
- `src/providers/discovery/probing-service.ts` - Connection test implementation
- `dashboard/src/features/providers/ProvidersPage.tsx` - Dashboard form
- `dashboard/src/hooks/providers.ts` - `useTestByokConnection` hook

### Fix 2: DeepSeek Anthropic Migration
- `src/providers/metadata.ts` - Provider metadata (wire family default)
- `src/providers/specs/configured-openai-providers.ts` - Remove DeepSeek from generic providers
- `src/providers/specs/deepseek.ts` - Add dedicated DeepSeek spec
- `src/providers/default-registry.ts` - Register DeepSeek with Anthropic adapter
- `src/providers/adapters/anthropic.ts` - Anthropic adapter (already exists)

## Acceptance Criteria

### Fix 1: BYOK Base URL Validation
- Operators cannot accidentally paste full endpoint paths into Base URL field
- If they do, they receive a clear, actionable error message
- Connection test and auto-fetch models work correctly with properly formatted base URLs
- No breaking changes to existing BYOK providers with correct base URLs

### Fix 2: DeepSeek Anthropic Migration
- DeepSeek uses Anthropic Messages wire family (`messages`)
- DeepSeek requests go to `/anthropic/v1/messages` endpoint
- DeepSeek uses `x-api-key` header instead of `Authorization: Bearer`
- Model discovery still works via `/v1/models` endpoint
- All DeepSeek capabilities (tools, reasoning, vision) work correctly
- Streaming responses work correctly
- Existing DeepSeek accounts continue to work without manual intervention
- No breaking changes to the API gateway interface for clients
