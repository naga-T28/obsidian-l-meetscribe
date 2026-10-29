import { type App, ButtonComponent, Modal, Notice } from 'obsidian';
import type { RecoveryCandidate } from '../session/recovery';
import type { RecoverResult } from '../session/SessionManager';
import { stateLabel } from './labels';

export interface RecoveryActions {
	/** 保存済みのデータから処理し直す。notePathを渡すと、そのノートへ書き出す。 */
	reprocess(sessionId: string, notePath?: string): Promise<RecoverResult>;
	/** 書き出し用の新しいノートを作り、そのパスを返す。 */
	createExportNote(candidate: RecoveryCandidate): Promise<string>;
	discard(sessionId: string): Promise<void>;
}

/**
 * 起動時に見つかった未完了セッションを示し、再処理・書き出し・破棄を選ばせる。録音は再開しない。
 * 録音は再開しない。操作したセッションは一覧から外す。
 */
export class RecoveryModal extends Modal {
	private readonly candidates: RecoveryCandidate[];
	private readonly confirmingDiscard = new Set<string>();

	constructor(
		app: App,
		candidates: readonly RecoveryCandidate[],
		private readonly actions: RecoveryActions,
	) {
		super(app);
		this.candidates = [...candidates];
	}

	onOpen(): void {
		this.setTitle('未完了の会議');
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		if (this.candidates.length === 0) {
			contentEl.createEl('p', { text: '未完了の会議はありません。' });
			return;
		}
		contentEl.createEl('p', { text: '前回の終了時に処理が終わっていない会議があります。録音は再開しません。保存済みのデータの扱いを選んでください。' });
		for (const candidate of this.candidates) {
			this.renderCandidate(contentEl.createDiv({ cls: 'lms-recovery-item' }), candidate);
		}
	}

	private renderCandidate(el: HTMLElement, candidate: RecoveryCandidate): void {
		const { session, reconciliation } = candidate;
		if (session === undefined) {
			el.createDiv({ cls: 'lms-recovery-title', text: `作業領域 ${candidate.sessionId}` });
		} else {
			el.createDiv({ cls: 'lms-recovery-title', text: `${session.notePath}（${new Date(session.startedAt).toLocaleString()}開始、${stateLabel(session.state)}）` });
		}
		const notes: string[] = [];
		if (candidate.error !== undefined) {
			notes.push(`作業データを読めません: ${candidate.error}`);
		}
		if (reconciliation !== undefined && reconciliation.added.length > 0) {
			notes.push(`通知前に終了したチャンクが${reconciliation.added.length}件あります。再処理の対象に加えます。`);
		}
		if (reconciliation !== undefined && reconciliation.unknownTime.length > 0) {
			notes.push(`時刻情報のないチャンクが${reconciliation.unknownTime.length}件あります。文字起こしには使わず、作業領域に残します。`);
		}
		if (reconciliation !== undefined && reconciliation.missingFiles.length > 0) {
			notes.push(`記録はあるのに音声ファイルがないチャンクが${reconciliation.missingFiles.length}件あります。この部分は文字起こしできません。`);
		}
		if (candidate.workAudioDeleted === true) {
			notes.push('作業音声は削除済みです。文字起こしの結果から反映と完了処理だけを行います。');
		}
		for (const text of notes) {
			el.createDiv({ cls: 'lms-recovery-note', text });
		}

		const controls = el.createDiv({ cls: 'lms-block-controls' });
		if (session !== undefined && candidate.error === undefined) {
			new ButtonComponent(controls)
				.setButtonText('保存済み音声から再処理')
				.setCta()
				.onClick(() => void this.run(candidate, async () => this.report(await this.actions.reprocess(candidate.sessionId))));
			new ButtonComponent(controls).setButtonText('別ノートへ書き出す').onClick(
				() =>
					void this.run(candidate, async () => {
						const notePath = await this.actions.createExportNote(candidate);
						this.report(await this.actions.reprocess(candidate.sessionId, notePath));
					}),
			);
		}
		// 作業音声と記録は元に戻せないため、1回目の操作では確認を求めるだけにする。
		const confirming = this.confirmingDiscard.has(candidate.sessionId);
		if (confirming) {
			el.createDiv({
				cls: 'lms-block-warning',
				text: 'この会議の作業データ（作業音声・文字起こしの記録）を削除します。ノートとVaultに保存済みの音声は残ります。元に戻せません。',
			});
		}
		new ButtonComponent(controls)
			.setButtonText(confirming ? '削除する' : '破棄')
			.setWarning()
			.onClick(() => {
				if (!confirming) {
					this.confirmingDiscard.add(candidate.sessionId);
					this.render();
					return;
				}
				this.confirmingDiscard.delete(candidate.sessionId);
				void this.run(candidate, () => this.actions.discard(candidate.sessionId));
			});
	}

	private report(result: RecoverResult): void {
		if (!result.ok && result.reason === 'busy') {
			throw new Error(`別の会議（${result.active?.notePath ?? '開始処理中'}）を処理中です。終わってから操作してください。`);
		}
		if (!result.ok) {
			throw new Error('この会議は完了済みです。');
		}
	}

	/** 操作を始めたら一覧から外す。再処理の進み具合は会議ブロックとステータスバーに出る。 */
	private async run(candidate: RecoveryCandidate, action: () => Promise<void>): Promise<void> {
		const index = this.candidates.indexOf(candidate);
		this.candidates.splice(index, 1);
		this.render();
		try {
			await action();
		} catch (error) {
			this.candidates.splice(index, 0, candidate);
			this.render();
			new Notice(`未完了の会議を処理できません: ${error instanceof Error ? error.message : String(error)}`, 10_000);
		}
	}
}
