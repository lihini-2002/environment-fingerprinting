import { createLocaleProbes } from './locale.js';
import { createNetworkProbes } from './network.js';
import { createHostArtifactProbes } from './host-artifacts.js';
import { createFilesystemProbes } from './filesystem.js';
import { createProcessStateProbes } from './process-state.js';
import { createContainerProbes } from './container.js';
import { createEnvironmentProbes } from './environment.js';
import { createOSProbes } from './os-machine.js';
import { createCPUProbes } from './cpu.js';
import { createResourceProbes } from './resources.js';
import { createSessionProbes } from './session.js';
import { createRuntimeProbes } from './runtime.js';
import { createInstallationProbes } from './installation.js';
import { createToolProbes } from './tools.js';
import { createProjectProbes } from './project.js';

export { createLocaleProbes, createNetworkProbes, createHostArtifactProbes, createOSProbes, createCPUProbes, createResourceProbes, createSessionProbes, createRuntimeProbes, createInstallationProbes, createProjectProbes, createToolProbes, createEnvironmentProbes, createContainerProbes, createProcessStateProbes, createFilesystemProbes };
export const defaultProbes = Object.freeze([
  ...createOSProbes(), ...createCPUProbes(), ...createResourceProbes(),
  ...createSessionProbes(),
  ...createRuntimeProbes(),
  ...createInstallationProbes(),
  ...createProjectProbes(),
  ...createToolProbes(),
  ...createEnvironmentProbes(),
  ...createContainerProbes(),
  ...createProcessStateProbes(),
  ...createFilesystemProbes(),
  ...createHostArtifactProbes(),
  ...createNetworkProbes(),
  ...createLocaleProbes(),
].map(Object.freeze));
