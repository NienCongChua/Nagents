import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import { IBulkEditService, ResourceTextEdit } from '../../../../editor/browser/services/bulkEditService.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';

export const ICascadeEngine = createDecorator<ICascadeEngine>('cascadeEngine');

export interface IDependencyReportItem {
	file: string;
	references: number;
}

export interface ICascadeEngine {
	readonly _serviceBrand: undefined;
	orchestrate(sourceFileUri: URI, sourceFileContent: string, report: IDependencyReportItem[]): Promise<void>;
}

interface IAgentPatchResult {
	file: string;
	patch: string;
}

export class CascadeEngine extends Disposable implements ICascadeEngine {
	public readonly _serviceBrand: undefined;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INotificationService private readonly notificationService: INotificationService,
		@IFileService private readonly fileService: IFileService,
		@IBulkEditService private readonly bulkEditService: IBulkEditService,
		@ITextModelService private readonly textModelService: ITextModelService
	) {
		super();
		console.log('[Cascade AI] Engine Started.');
	}

	private get apiKey(): string {
		return this.configurationService.getValue<string>('cascade.openRouterApiKey') || '';
	}

	public async orchestrate(sourceFileUri: URI, sourceFileContent: string, report: IDependencyReportItem[]): Promise<void> {
		if (!this.apiKey) {
			this.notificationService.warn('Cascade AI requires an OpenRouter API key inside Settings to run patches.');
			return;
		}

		this.notificationService.info(`Cascade Orchestrator: Spawning swarm for ${report.length} files...`);

		try {
			// 1. Spawning the Coder Swarm in parallel
			const swarmPromises = report.map(async item => {
				const targetUri = URI.file(item.file);
				const targetFileContent = await this.fileService.readFile(targetUri);
				return this.runCoderAgent(sourceFileContent, targetFileContent.value.toString(), item.file);
			});

			const patches = await Promise.all(swarmPromises);

			// 2. The Reviewer Agent
			const passedReview = await this.runReviewerAgent(patches);

			if (passedReview) {
				this.notificationService.info(`Cascade AI: Swarm patches APPROVED for ${report.length} files.`);
				await this.applyAutoMerge(patches);
			} else {
				this.notificationService.error('Cascade AI: Reviewer agent REJECTED the generated patches due to potential logic flaws.');
			}
		} catch (error) {
			console.error('[Cascade AI] Swarm Execution Failed:', error);
			this.notificationService.error('Cascade AI: Execution failed.');
		}
	}

	private async applyAutoMerge(patches: IAgentPatchResult[]) {
		const edits: ResourceTextEdit[] = [];

		for (const p of patches) {
			const targetUri = URI.file(p.file);
			
			// Extract SEARCH/REPLACE blocks
			const regex = /<<<<<<< SEARCH\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>> REPLACE/g;
			let match;
			
			while ((match = regex.exec(p.patch)) !== null) {
				let searchBlock = match[1];
				const replaceBlock = match[2];
				
				// Strip trailing newlines sometimes added by markdown
				if (searchBlock.endsWith('\n')) searchBlock = searchBlock.slice(0, -1);
				
				const ref = await this.textModelService.createModelReference(targetUri);
				try {
					const model = ref.object.textEditorModel;
					// Search for identical text. (Use exact string matching, regex = false, caseSensitive = true, matchWholeWord = false)
					const matches = model.findMatches(searchBlock, false, false, true, null, true);
					
					if (matches.length > 0) {
						// Create a ResourceTextEdit
						edits.push(new ResourceTextEdit(targetUri, {
							range: matches[0].range,
							text: replaceBlock
						}));
					} else {
						console.error(`[Cascade AI] Could not find the SEARCH block in ${p.file}`);
						this.notificationService.warn(`Cascade Auto-Merger: Could not confidently apply a patch section in ${p.file}. Manual review required.`);
					}
				} finally {
					ref.dispose();
				}
			}
		}

		if (edits.length > 0) {
			await this.bulkEditService.apply(edits, { label: 'Cascade Refactoring Merge' });
			this.notificationService.info(`Cascade Auto-Merger Complete! Applied ${edits.length} automated LLM patches.`);
		} else {
			this.notificationService.warn('Cascade Auto-Merger: No valid SEARCH/REPLACE blocks found in LLM output.');
		}
	}

	private async runCoderAgent(sourceFileContent: string, targetFileContent: string, targetFilePath: string): Promise<IAgentPatchResult> {
		const prompt = `You are an elite Coder Agent. The user has modified a source file and you need to update a dependent file to match.
SOURCE FILE CONTENT:
${sourceFileContent}

TARGET FILE (Needs Update):
${targetFileContent}

INSTRUCTIONS: Analyze what changed in the SOURCE file based on normal TypeScript conventions. Apply necessary updates to the TARGET FILE.
You must output ONLY standard diff patches in the following format:
<<<<<<< SEARCH
[Exact old code]
=======
[New fixed code]
>>>>>>> REPLACE
`;
		
		const response = await this.callOpenRouter('anthropic/claude-3-haiku', prompt);
		return { file: targetFilePath, patch: response };
	}

	private async runReviewerAgent(patches: IAgentPatchResult[]): Promise<boolean> {
		const patchLog = patches.map(p => `FILE: ${p.file}\nPATCH: ${p.patch}`).join('\n\n');
		const prompt = `You are a strict code Reviewer Agent. Review the following proposed refactoring patches.
PATCHES:
${patchLog}

INSTRUCTIONS: Check for obvious syntax errors, broken imports, or missing variables. 
If the patches look functionally safe to apply, output ONLY the exact word "APPROVED". Otherwise, output "REJECTED".`;

		const response = await this.callOpenRouter('anthropic/claude-3-opus', prompt);
		return response.includes('APPROVED');
	}

	private async callOpenRouter(model: string, prompt: string): Promise<string> {
		try {
			const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${this.apiKey}`,
					'Content-Type': 'application/json',
					'HTTP-Referer': 'https://cascade-ide.local',
					'X-Title': 'Cascade Refactor Swarm'
				},
				body: JSON.stringify({
					model,
					messages: [{ role: 'user', content: prompt }]
				})
			});

			if (!res.ok) {
				throw new Error(`OpenRouter Error: ${res.statusText}`);
			}

			const data = await res.json();
			return data.choices?.[0]?.message?.content || '';
		} catch (err: any) {
			console.error('[Cascade Engine] LLM Fetch Error:', err);
			return '';
		}
	}
}
