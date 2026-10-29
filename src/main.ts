import { FileSystemAdapter, Notice, normalizePath, Plugin, requestUrl } from 'obsidian';
import { join, posix } from 'path';
import { type DeviceList, HELPER_FILE_NAME, HelperClient } from './audio/HelperClient';
import { WorkAudioCleaner } from './audio/WorkAudioCleaner';
import { NoteWriter } from './note/NoteWriter';
import { ObsidianNoteAccess } from './note/ObsidianNoteAccess';
import { applyReconciliation, findRecoveryCandidates, type RecoveryCandidate } from './session/recovery';
import { SessionManager } from './session/SessionManager';
import { defaultSessionsRoot, SessionStore } from './session/SessionStore';
import { type LMeetscribeSettings, parseSettings } from './settings/settings';
import { LMeetscribeSettingTab } from './settings/SettingTab';
import { WhisperTranscriber } from './transcription/ChunkQueue';
import { getOllamaModelDetails, listOllamaModels } from './summary/OllamaProvider';
import { createProviderResolver } from './summary/resolveProvider';
import { SummaryService } from './summary/SummaryService';
import { listWhisperModels } from './transcription/ModelScanner';
import { MeetingBlockView } from './ui/MeetingBlock';
import { RecoveryModal } from './ui/RecoveryModal';
import { StatusBarView } from './ui/StatusBar';

export default class LMeetscribePlugin extends Plugin {
	settings!: LMeetscribeSettings;
	sessionStore!: SessionStore;
	helper!: HelperClient;
	notes!: NoteWriter;
	summaries!: SummaryService;
	/** 録音セッションはプラグインが所有する。ブロックとステータスバーは状態を購読するだけ。 */
	sessions!: SessionManager;
	private deviceList: Promise<DeviceList> | undefined;

	async onload(): Promise<void> {
		try {
			this.settings = parseSettings(await this.loadData());
		} catch (error) {
			// 読めない設定を初期値で上書きしないよう、読み込みを中止する。
			new Notice(`L Meetscribe: ${error instanceof Error ? error.message : String(error)}`);
			throw error;
		}
		if (this.settings.vaultId === '') {
			this.settings.vaultId = crypto.randomUUID();
			await this.saveSettings();
		}
		const store = new SessionStore(defaultSessionsRoot(this.settings.vaultId));
		this.sessionStore = store;
		this.helper = new HelperClient({
			executablePath: this.helperPath(),
			pluginVersion: this.manifest.version,
			sessionDir: (sessionId) => store.sessionDir(sessionId),
		});
		this.notes = new NoteWriter(new ObsidianNoteAccess(this.app), store);
		const notes = this.notes;
		this.summaries = new SummaryService({
			store,
			readTranscript: (path, sessionId) => notes.readTranscript(path, sessionId),
			resolveProvider: createProviderResolver({
				getSecret: (id) => this.app.secretStorage.getSecret(id),
				// 4xx・5xxも例外にせず受け取り、種類ごとに扱う。
				post: async ({ url, headers, body }) => {
					const response = await requestUrl({ url, method: 'POST', headers, body, throw: false });
					return { status: response.status, headers: response.headers, text: response.text };
				},
			}),
			createRunId: () => crypto.randomUUID(),
		});
		this.sessions = new SessionManager({
			store,
			recorder: this.helper,
			transcriber: new WhisperTranscriber({ store }),
			notes: this.notes,
			workAudio: new WorkAudioCleaner(store),
			summarizer: this.summaries,
			getSettings: () => this.settings,
			createSessionId: () => crypto.randomUUID(),
			now: () => new Date(),
		});

		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => void this.sessions.noteRenamed(oldPath, file.path)));
		this.registerMarkdownCodeBlockProcessor('lms', (source, el, ctx) => {
			ctx.addChild(new MeetingBlockView(el, this, source, ctx));
		});
		new StatusBarView(this.addStatusBarItem(), this.sessions, (path) => void this.app.workspace.openLinkText(path, '')).attach(this);
		this.addSettingTab(new LMeetscribeSettingTab(this.app, this, {
			whisper: listWhisperModels,
			ollama: (url) => listOllamaModels(url),
			ollamaDetails: (url, model) => getOllamaModelDetails(url, model),
		}));

		this.addCommand({
			id: 'show-unfinished-meetings',
			name: '未完了の会議を表示',
			callback: () => void this.showRecovery(true),
		});
		// 録音は自動再開しない（利用者の知らないうちに録音しないため）。起動時は未完了の会議を示すだけにする。
		this.app.workspace.onLayoutReady(() => void this.showRecovery(false));
	}

	onunload(): void {
		// 録音中ならヘルパーへ停止を送り、端数まで書かせる。状態は未完了のまま残り、次回の復旧対象になる。
		// 実行中の要約を打ち切り、後から返った結果を保存しない。
		this.summaries?.cancelAll();
		void this.sessions?.shutdown();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** デバイス一覧はヘルパーを起動して取得するため、再読み込みを求められるまで結果を使い回す。 */
	loadDevices(refresh: boolean): Promise<DeviceList> {
		if (refresh || this.deviceList === undefined) {
			const request = this.helper.listDevices();
			this.deviceList = request;
			// 失敗した結果は使い回さない。
			request.catch(() => {
				if (this.deviceList === request) {
					this.deviceList = undefined;
				}
			});
		}
		return this.deviceList;
	}

	/** 未完了の会議を探して示す。起動時は見つかった場合だけ開く。 */
	private async showRecovery(always: boolean): Promise<void> {
		let candidates: RecoveryCandidate[];
		try {
			candidates = (await findRecoveryCandidates(this.sessionStore)).filter((candidate) => !this.sessions.isActive(candidate.sessionId));
		} catch (error) {
			new Notice(`L Meetscribe: 未完了の会議を確認できません: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		if (candidates.length === 0 && !always) {
			return;
		}
		const store = this.sessionStore;
		new RecoveryModal(this.app, candidates, {
			reprocess: (sessionId, notePath) =>
				this.sessions.recover(sessionId, async (record) => {
					await applyReconciliation(store, record);
					if (notePath !== undefined) {
						record.notePath = notePath;
						// 反映の記録は元のノートの分。新しいノートへは文字起こしの全文を書く。
						await store.saveNoteProgress(record.sessionId, { reflectedWindows: 0 });
					}
				}),
			createExportNote: (candidate) => this.createExportNote(candidate),
			discard: async (sessionId) => {
				if (this.sessions.isActive(sessionId)) {
					throw new Error('処理中の会議は破棄できません。');
				}
				await store.deleteSession(sessionId);
			},
		}).open();
	}

	/**
	 * 書き出し用のノートを元のノートと同じフォルダ（なければVaultの直下）に作る。
	 * 同じブロックIDの空のlmsブロックを置き、出力領域は再処理の準備で作る。
	 */
	private async createExportNote(candidate: RecoveryCandidate): Promise<string> {
		const session = candidate.session;
		if (session === undefined) {
			throw new Error('作業データを読めない会議は書き出せません。');
		}
		const { vault } = this.app;
		const folder = posix.dirname(session.notePath);
		const base = folder !== '.' && vault.getFolderByPath(folder) !== null ? `${folder}/` : '';
		const started = new Date(session.startedAt);
		const pad = (value: number): string => String(value).padStart(2, '0');
		const stamp = `${started.getFullYear()}-${pad(started.getMonth() + 1)}-${pad(started.getDate())} ${pad(started.getHours())}${pad(started.getMinutes())}`;
		let path = normalizePath(`${base}会議の書き出し ${stamp}.md`);
		for (let index = 2; vault.getAbstractFileByPath(path) !== null; index++) {
			path = normalizePath(`${base}会議の書き出し ${stamp} (${index}).md`);
		}
		await vault.create(path, `\`\`\`lms\nid: ${session.blockId}\n\`\`\`\n`);
		return path;
	}

	/** ヘルパーはプラグインのフォルダに置く（scripts/setup.shが配置する）。 */
	private helperPath(): string {
		if (this.manifest.dir === undefined) {
			throw new Error('L Meetscribeはデスクトップ版のローカルVaultでだけ動作します。');
		}
		return join(this.vaultRoot(), this.manifest.dir, HELPER_FILE_NAME);
	}

	/** 録音ヘルパーの起動にVaultの絶対パスが要る。 */
	private vaultRoot(): string {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			throw new Error('L Meetscribeはデスクトップ版のローカルVaultでだけ動作します。');
		}
		return adapter.getBasePath();
	}
}
