import { ApiError, CLIENT_API_VERSION, ApiCore } from './domains/core.js';
import { AuthApi } from './domains/auth.js';
import { SettingsApi } from './domains/settings.js';
import { PatientsApi } from './domains/patients.js';
import { BrainApi } from './domains/brain.js';
import { MemoryApi } from './domains/memory.js';
import { FilesApi } from './domains/files.js';
import { AdminApi } from './domains/admin.js';
import { ResearchApi } from './domains/research.js';
import { SkillsApi } from './domains/skills.js';
import { WritingApi } from './domains/writing.js';
import { KnowledgeApi } from './domains/knowledge.js';
import { CalendarApi } from './domains/calendar.js';
import { PluginsApi } from './domains/plugins.js';
import { SubmissionApi } from './domains/submission.js';
import { ChatApi } from './domains/chat.js';

/**
 * #458 — ApiClient is COMPOSITION, not a 15-deep inheritance chain.
 *
 * Each domain is a flat class over ApiCore (shared token/fetch plumbing).
 * The merged method surface is declared via the `ApiClient` interface
 * (type-safe for every call site) and assembled at runtime with Object.assign
 * — the single `api` instance keeps exactly the same surface as before.
 */
export interface ApiClient
  extends ApiCore,
    AuthApi,
    SettingsApi,
    PatientsApi,
    BrainApi,
    MemoryApi,
    FilesApi,
    AdminApi,
    ResearchApi,
    SkillsApi,
    WritingApi,
    KnowledgeApi,
    CalendarApi,
    PluginsApi,
    SubmissionApi,
    ChatApi {}

export const ApiClient: new () => ApiClient = function ApiClient(this: any) {
  const parts = [
    new AuthApi(),
    new SettingsApi(),
    new PatientsApi(),
    new BrainApi(),
    new MemoryApi(),
    new FilesApi(),
    new AdminApi(),
    new ResearchApi(),
    new SkillsApi(),
    new WritingApi(),
    new KnowledgeApi(),
    new CalendarApi(),
    new PluginsApi(),
    new SubmissionApi(),
    new ChatApi(),
  ];
  // Class methods live on the prototype chain (domain class → ApiCore) —
  // walk the whole chain and bind every method to its owning instance so
  // `this.fetch` / `this.headers` keep working on the composed facade.
  for (const part of parts) {
    let proto = Object.getPrototypeOf(part);
    while (proto && proto !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        if (typeof (part as any)[name] === 'function') {
          (this as any)[name] = (part as any)[name].bind(part);
        }
      }
      proto = Object.getPrototypeOf(proto);
    }
  }
} as unknown as new () => ApiClient;

export const api = new ApiClient();
export { ApiError, CLIENT_API_VERSION };
