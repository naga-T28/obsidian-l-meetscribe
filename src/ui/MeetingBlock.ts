import { type App, ButtonComponent, DropdownComponent, type MarkdownPostProcessorContext, MarkdownRenderChild, Notice } from 'obsidian';
import type { DeviceList } from '../audio/HelperClient';
import { findMeetingBlockIds, parseMeetingBlock } from '../note/meetingBlock';
import type { NoteWriter } from '../note/NoteWriter';
import type { SessionSnapshot } from '../session/RecordingSession';
import type { SessionManager } from '../session/SessionManager';
import type { LMeetscribeSettings } from '../settings/settings';
import { describeFailure, diskSpaceWarning, formatElapsed, noteProblemWarning, otherSilenceWarning, stateLabel } from './labels';

export interface MeetingBlockHost {
	app: App;
	sessions: SessionManager;
	settings: LMeetscribeSettings;
	notes: Pick<NoteWriter, 'assignBlockId'>;
	/** 録音ヘルパーから取得したデバイス一覧。refreshがfalseなら前回の結果を使う。 */
	loadDevices(refresh: boolean): Promise<DeviceList>;
}

/**
 * lmsブロックの表示と操作。録音資源は持たず、SessionManagerの状態を購読して描画する。
 * ブロックの再描画・ノートの切り替えでこの表示が破棄されても、録音は続く。
 */
export class MeetingBlockView extends MarkdownRenderChild {
	private snapshot: SessionSnapshot | undefined;
	private devices: DeviceList | undefined;
	private deviceError: string | undefined;
	private microphoneUid: string;
	private outputUid: string;
	private starting = false;
	private elapsedEl: HTMLElement | undefined;

	constructor(
		containerEl: HTMLElement,
		private readonly host: MeetingBlockHost,
		private readonly source: string,
		private readonly ctx: MarkdownPostProcessorContext,
	) {
		super(containerEl);
		this.microphoneUid = host.settings.recording.microphoneDeviceUid;
		this.outputUid = host.settings.recording.outputDeviceUid;
	}

	onload(): void {
		this.register(
			this.host.sessions.subscribe((snapshot) => {
				this.snapshot = snapshot;
				this.render();
			}),
		);
		this.registerInterval(window.setInterval(() => this.updateElapsed(), 1000));
		void this.loadDevices(false);
	}

	private get blockId(): string | undefined {
		return parseMeetingBlock(this.source).id;
	}

	/** このブロックの会議。別のブロックの会議ならundefined。 */
	private get own(): SessionSnapshot | undefined {
		const id = this.blockId;
		return id !== undefined && this.snapshot?.blockId === id ? this.snapshot : undefined;
	}

	private render(): void {
		const el = this.containerEl;
		el.empty();
		el.addClass('lms-block');
		this.elapsedEl = undefined;

		const parsed = parseMeetingBlock(this.source);
		if (!parsed.empty && parsed.id === undefined) {
			el.createDiv({ cls: 'lms-block-error', text: '会議ブロックの内容を読めません。新しい空のlmsブロックを使ってください。' });
			return;
		}

		const own = this.own;
		const header = el.createDiv({ cls: 'lms-block-header' });
		header.createSpan({ cls: 'lms-block-state', text: own === undefined ? '待機中' : stateLabel(own.state) });
		if (own?.state === 'preparing' || own?.state === 'recording') {
			this.elapsedEl = header.createSpan({ cls: 'lms-block-elapsed' });
			this.updateElapsed();
		}
		if (own?.state === 'recording' || own?.state === 'draining') {
			header.createSpan({ cls: 'lms-block-progress', text: `未処理のチャンク ${own.transcription.queued}` });
		}
		if (own?.summaryProgress !== undefined) {
			header.createSpan({ cls: 'lms-block-progress', text: `要約 ${own.summaryProgress.completed}/${own.summaryProgress.total}` });
		}

		if (own === undefined) {
			this.renderIdle(el);
		} else {
			this.renderSession(el, own);
		}

		el.createDiv({
			cls: 'lms-block-note',
			text: 'ヘッドホンを使ってください。話者は入力経路で区別します（マイクは自分、再生音は相手）。同室の複数人やスピーカーからの回り込みは区別できません。',
		});
	}

	private renderIdle(el: HTMLElement): void {
		const recorded = parseMeetingBlock(this.source).session;
		if (recorded !== undefined) {
			// 1ブロックにつき1セッション。結果はブロックの上の出力領域にある。
			el.createDiv({ cls: 'lms-block-message', text: 'この会議ブロックは録音済みです。新しい録音には新しい空のlmsブロックを使ってください。' });
			// 再起動後も、完了済みの会議を手動で要約・再生成できるようにする。
			const controls = el.createDiv({ cls: 'lms-block-controls' });
			new ButtonComponent(controls).setButtonText('要約を生成').onClick(() => void this.summarize(recorded));
			return;
		}
		const active = this.snapshot;
		if (active !== undefined && active.state !== 'completed') {
			el.createDiv({ cls: 'lms-block-message', text: `別の会議（${active.notePath}）が${stateLabel(active.state)}です。終わってから開始してください。` });
			return;
		}

		const controls = el.createDiv({ cls: 'lms-block-controls' });
		const microphone = new DropdownComponent(controls).addOption('', '既定の入力');
		for (const device of this.devices?.inputs ?? []) {
			microphone.addOption(device.uid, device.name);
		}
		addMissingOption(microphone, this.microphoneUid, this.devices?.inputs);
		microphone.setValue(this.microphoneUid).onChange((value) => {
			this.microphoneUid = value;
		});

		const output = new DropdownComponent(controls).addOption('', 'すべての出力');
		for (const device of this.devices?.outputs ?? []) {
			output.addOption(device.uid, device.name);
		}
		addMissingOption(output, this.outputUid, this.devices?.outputs);
		output.setValue(this.outputUid).onChange((value) => {
			this.outputUid = value;
		});

		new ButtonComponent(controls).setButtonText('デバイスを再読み込み').onClick(() => void this.loadDevices(true));
		new ButtonComponent(controls)
			.setButtonText('録音開始')
			.setCta()
			.setDisabled(this.starting)
			.onClick(() => void this.start());

		if (this.deviceError !== undefined) {
			el.createDiv({ cls: 'lms-block-error', text: this.deviceError });
		}
	}

	private renderSession(el: HTMLElement, own: SessionSnapshot): void {
		for (const warning of [otherSilenceWarning(own), diskSpaceWarning(own), noteProblemWarning(own)]) {
			if (warning !== undefined) {
				el.createDiv({ cls: 'lms-block-warning', text: warning });
			}
		}
		const controls = el.createDiv({ cls: 'lms-block-controls' });
		switch (own.state) {
			case 'recording':
				new ButtonComponent(controls)
					.setButtonText('録音停止')
					.setWarning()
					.onClick(() => void this.host.sessions.stop());
				return;
			case 'error': {
				if (own.failure !== undefined) {
					const { summary, guidance } = describeFailure(own.failure);
					el.createDiv({ cls: 'lms-block-error', text: summary });
					el.createDiv({ cls: 'lms-block-message', text: guidance });
				}
				new ButtonComponent(controls).setButtonText('再試行').onClick(() => void this.host.sessions.retry());
				new ButtonComponent(controls).setButtonText('閉じる').onClick(() => this.host.sessions.release());
				return;
			}
			case 'completed':
				for (const exclusion of own.exclusions ?? []) {
					el.createDiv({ cls: 'lms-block-warning', text: `除外: ${exclusion}` });
				}
				if (own.summary?.status === 'success') {
					el.createDiv({ cls: 'lms-block-message', text: '要約をノートへ出力しました。再生成すると、編集した要約は残したまま新しい案を追記します。' });
				} else if (own.summary?.status === 'skipped') {
					el.createDiv({ cls: 'lms-block-message', text: `要約を省略しました: ${own.summary.reason}` });
				} else if (own.summary?.status === 'failed') {
					el.createDiv({ cls: 'lms-block-error', text: `要約に失敗しました（文字起こしは完了しています）: ${own.summary.reason}` });
				}
				new ButtonComponent(controls).setButtonText('要約を生成').onClick(() => void this.summarize(own.sessionId));
				return;
			default:
				return;
		}
	}

	private updateElapsed(): void {
		const own = this.own;
		if (this.elapsedEl !== undefined && own !== undefined) {
			this.elapsedEl.setText(formatElapsed(own.startedAt, new Date()));
		}
	}

	private async loadDevices(refresh: boolean): Promise<void> {
		try {
			this.devices = await this.host.loadDevices(refresh);
			this.deviceError = undefined;
		} catch (error) {
			this.deviceError = `デバイス一覧を取得できません: ${describe(error)}`;
		}
		this.render();
	}

	/**
	 * 開始の結果はNoticeで示す。初回はブロックへIDを書き込むため、この表示は再描画で破棄される。
	 * 開始後の状態は新しい表示がSessionManagerから受け取る。
	 */
	private async start(): Promise<void> {
		if (this.starting) {
			return;
		}
		this.starting = true;
		this.render();
		try {
			const blockId = await this.ensureBlockId();
			const result = await this.host.sessions.start({
				blockId,
				notePath: this.ctx.sourcePath,
				devices: { microphoneDeviceUid: this.microphoneUid, outputDeviceUid: this.outputUid },
			});
			if (!result.ok && result.reason === 'busy') {
				new Notice(`別の会議（${result.active?.notePath ?? '開始処理中'}）を処理中のため、録音を開始できません。`);
			} else if (!result.ok) {
				new Notice(`録音を開始できません。\n${result.problems.join('\n')}`, 10_000);
			}
		} catch (error) {
			new Notice(`録音を開始できません: ${describe(error)}`, 10_000);
		} finally {
			this.starting = false;
			this.render();
		}
	}

	/** 空のブロックにはIDを付ける。IDがあればノート内で重複していないかを確かめる。 */
	private async ensureBlockId(): Promise<string> {
		const { vault } = this.host.app;
		const file = vault.getFileByPath(this.ctx.sourcePath);
		if (file === null) {
			throw new Error('会議ブロックのノートが見つかりません。');
		}
		const existing = this.blockId;
		if (existing !== undefined) {
			const ids = findMeetingBlockIds(await vault.read(file));
			if (ids.filter((id) => id === existing).length > 1) {
				throw new Error('このノートに同じIDの会議ブロックが複数あります。新しい空のlmsブロックを使ってください。');
			}
			return existing;
		}
		const section = this.ctx.getSectionInfo(this.containerEl);
		if (section === null) {
			throw new Error('会議ブロックの位置を特定できません。ノートを開いた状態で操作してください。');
		}
		const id = crypto.randomUUID();
		await this.host.notes.assignBlockId(file.path, section.lineStart, section.lineEnd, id);
		return id;
	}

	/** 実行時の要約設定で要約する。結果と進捗はSessionManagerの状態としてこのブロックに表示される。 */
	private async summarize(sessionId: string): Promise<void> {
		let result;
		try {
			result = await this.host.sessions.summarize(sessionId);
		} catch (error) {
			new Notice(`要約できません: ${describe(error)}`, 10_000);
			return;
		}
		if (!result.ok && result.reason === 'busy') {
			new Notice(`別の会議（${result.active?.notePath ?? '開始処理中'}）を処理中のため、要約できません。`);
		} else if (!result.ok) {
			new Notice('この会議はまだ完了していないため、要約できません。コマンド「未完了の会議を表示」から再処理してください。', 10_000);
		}
	}
}

/** 設定や前回の選択にあるが、現在の一覧にないデバイスも選択肢に残す。 */
function addMissingOption(dropdown: DropdownComponent, uid: string, devices: { uid: string }[] | undefined): void {
	if (uid !== '' && !(devices ?? []).some((device) => device.uid === uid)) {
		dropdown.addOption(uid, `${uid}（見つかりません）`);
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
