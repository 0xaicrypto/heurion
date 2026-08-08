import { ApiError, CLIENT_API_VERSION } from './domains/core.js';
import { SubmissionApi } from './domains/submission.js';


/**
 * #347: api-client split by domain — each domain class extends the previous
 * (core → auth → settings → patients → brain → memory → files → admin →
 * research → skills → writing → knowledge → calendar → plugins → submission), so the
 * single `api` instance keeps the exact same surface as before.
 */
export class ApiClient extends SubmissionApi {}

export const api = new ApiClient();
export { ApiError, CLIENT_API_VERSION };
