import type { Plugin } from 'obsidian';
import type { SessionSnapshot } from '../session/RecordingSession';
import type { SessionManager } from '../session/SessionManager';
import { formatElapsed, stateLabel } from './labels';

/**
 * ノートを閉じた後も録音状態を示し、停止できるようにする。
 * 表示はプラグインが所有し、onunloadで登録ごと解除される。
 */
export class StatusBarView {
	private snapshot: SessionSnapshot | undefined;

	constructor(
		private readonly el: HTMLElement,
		private readonly sessions: SessionManager,
		private readonly openNote: (path: string) => void,
	) {
		el.addClass('lms-status');
	}

	attach(plugin: Plugin): void {
		plugin.register(
			this.sessions.subscribe((snapshot) => {
				this.snapshot = snapshot;
				this.render();
			}),
		);
		plugin.registerInterval(
			window.setInterval(() => {
				if (this.snapshot?.state === 'recording') {
					this.render();
				}
			}, 1000),
		);
	}

	private render(): void {
		const snapshot = this.snapshot;
		this.el.empty();
		const visible = snapshot !== undefined && snapshot.state !== 'completed';
		this.el.toggle(visible);
		if (!visible) {
			return;
		}
		const parts = [`会議 ${stateLabel(snapshot.state)}`];
		if (snapshot.state === 'recording') {
			parts.push(formatElapsed(snapshot.startedAt, new Date()));
		}
		if (snapshot.state === 'recording' || snapshot.state === 'draining') {
			parts.push(`未処理 ${snapshot.transcription.queued}`);
		}
		if (snapshot.summaryProgress !== undefined) {
			parts.push(`${snapshot.summaryProgress.completed}/${snapshot.summaryProgress.total}`);
		}
		this.el.createSpan({ text: parts.join(' ') });
		this.el.setAttr('aria-label', snapshot.notePath);

		if (snapshot.state === 'recording') {
			this.addAction('停止', () => void this.sessions.stop());
		} else if (snapshot.state === 'error') {
			this.addAction('ノートを開く', () => this.openNote(snapshot.notePath));
		}
	}

	private addAction(text: string, onClick: () => void): void {
		const action = this.el.createSpan({ cls: 'lms-status-action', text });
		action.setAttr('role', 'button');
		action.addEventListener('click', onClick);
	}
}
