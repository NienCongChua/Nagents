import { Project } from 'ts-morph';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ISearchService, QueryType } from '../../../services/search/common/search.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { URI } from '../../../../base/common/uri.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ICascadeEngine } from './cascadeEngine.js';

export const ICascadeASTWorker = createDecorator<ICascadeASTWorker>('cascadeASTWorker');

export interface ICascadeASTWorker {
	readonly _serviceBrand: undefined;
}

export class CascadeASTWorker extends Disposable implements ICascadeASTWorker {
	public readonly _serviceBrand: undefined;
	private project: Project;

	constructor(
		@ITextFileService private readonly textFileService: ITextFileService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ISearchService private readonly searchService: ISearchService,
		@INotificationService private readonly notificationService: INotificationService,
		@ICascadeEngine private readonly cascadeEngine: ICascadeEngine
	) {
		super();
		console.log('[Cascade AI] Starting AST Worker (In-Memory FileSystem)...');

		this.project = new Project({
			useInMemoryFileSystem: true
		});

		this.initialize();
		this.bindEvents();
	}

	private async initialize() {
		try {
			console.log('[Cascade AI] Indexing workspace...');
			const folders = this.workspaceContextService.getWorkspace().folders;
			if (folders.length === 0) {
				return;
			}

			const query = {
				type: QueryType.File,
				folderQueries: folders.map(f => ({ folder: f.uri })),
				filePattern: '*.ts',
				maxResults: 1000 
			};

			const results = await this.searchService.fileSearch(query as any);
			
			let loadedCount = 0;
			for (const match of results.results) {
				if (match.resource.path.endsWith('.ts') && !match.resource.path.includes('node_modules')) {
					const fileContent = await this.fileService.readFile(match.resource);
					this.project.createSourceFile(match.resource.fsPath, fileContent.value.toString(), { overwrite: true });
					loadedCount++;
				}
			}
			console.log(`[Cascade AI] Indexed ${loadedCount} TypeScript files into AST.`);
		} catch (error) {
			console.error(`[Cascade AI] Failed to index workspace:`, error);
		}
	}

	private bindEvents() {
		this._register(this.textFileService.files.onDidSave(e => {
			this.handleSave(e.model.resource).catch(console.error);
		}));
	}

	private async handleSave(resource: URI) {
		if (!resource.path.endsWith('.ts')) {
			return;
		}

		console.log(`[Cascade AI] Intercepted Save Event for: ${resource.fsPath}`);
		
		try {
			const fileContent = await this.fileService.readFile(resource);
			const text = fileContent.value.toString();

			const sourceFile = this.project.getSourceFile(resource.fsPath) 
				|| this.project.createSourceFile(resource.fsPath, text, { overwrite: true });
			
			sourceFile.replaceWithText(text);

			const dependencyReport: { file: string, references: number }[] = [];
			const exportedDeclarations = sourceFile.getExportedDeclarations();
			
			let totalReferences = 0;
			for (const [, declarations] of exportedDeclarations) {
				for (const decl of declarations) {
					// @ts-ignore
					if (decl.findReferences) {
						// @ts-ignore
						const refs = decl.findReferences();
						for (const ref of refs) {
							for (const refNode of ref.getReferences()) {
								const refFilePath = refNode.getSourceFile().getFilePath();
								if (refFilePath !== resource.fsPath) {
									const existing = dependencyReport.find(d => d.file === refFilePath);
									if (existing) {
										existing.references++;
									} else {
										dependencyReport.push({ file: refFilePath, references: 1 });
									}
									totalReferences++;
								}
							}
						}
					}
				}
			}

			if (dependencyReport.length > 0) {
				console.log(`[Cascade AI] Dependency_Report for ${resource.fsPath}:`, dependencyReport);
				this.notificationService.info(`Cascade Refactor: Detected ${totalReferences} dependent references across ${dependencyReport.length} files.`);
				
				// Pipe to Phase 3 Orchestrator
				this.cascadeEngine.orchestrate(resource, text, dependencyReport);
			} else {
				console.log(`[Cascade AI] No outward dependencies found for modifications in ${resource.fsPath}.`);
			}

		} catch (error) {
			console.error(`[Cascade AI] Error analyzing AST:`, error);
		}
	}
}
