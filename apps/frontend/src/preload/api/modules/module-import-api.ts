import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult, ModuleValidationResult, ModuleImportResult } from '../../../shared/types';
import { invokeIpc } from './ipc-utils';

/**
 * Module Import API operations
 */
export interface ModuleImportAPI {
  validateModuleFolder: (modulePath: string) => Promise<IPCResult<ModuleValidationResult>>;
  importModule: (projectId: string, modulePath: string) => Promise<IPCResult<ModuleImportResult>>;
}

/**
 * Creates the Module Import API implementation
 */
export const createModuleImportAPI = (): ModuleImportAPI => ({
  validateModuleFolder: (modulePath: string): Promise<IPCResult<ModuleValidationResult>> =>
    invokeIpc(IPC_CHANNELS.MODULE_IMPORT_VALIDATE, modulePath),

  importModule: (projectId: string, modulePath: string): Promise<IPCResult<ModuleImportResult>> =>
    invokeIpc(IPC_CHANNELS.MODULE_IMPORT_EXECUTE, projectId, modulePath),
});
