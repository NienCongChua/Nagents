import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { CascadeASTWorker } from './cascadeASTWorker.js';
import { ICascadeEngine, CascadeEngine } from './cascadeEngine.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';

// CASCADE AI - Register Settings
const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
configurationRegistry.registerConfiguration({
	id: 'cascade',
	order: 100,
	title: 'Cascade AI Refactor Engine',
	type: 'object',
	properties: {
		'cascade.openRouterApiKey': {
			type: 'string',
			default: '',
			description: 'API key for OpenRouter to power the Cascade Coder Swarm.'
		}
	}
});

// CASCADE AI - Register Singleton Services
registerSingleton(ICascadeEngine, CascadeEngine, InstantiationType.Delayed);

// CASCADE-AI-MODIFICATION: Entry point for Cascade AI Agent
export class CascadeAIContribution extends Disposable {
	private readonly worker: CascadeASTWorker;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) {
		super();
		console.log('[Cascade AI] Initializing module...');
		
		// Phase 2 will instantiate the AST background worker here
		this.worker = this.instantiationService.createInstance(CascadeASTWorker);
		this._register(this.worker);
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(CascadeAIContribution, LifecyclePhase.Restored);
