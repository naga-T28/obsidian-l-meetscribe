import { type App, MarkdownView, type TFile } from 'obsidian';
import { applyEdits, NoteWriteError, type TextEdit } from './meetingBlock';
import type { NoteAccess } from './NoteWriter';

/**
 * 編集中の対象ノートにはEditorのトランザクション、それ以外にはVault.processで書く。
 * 編集中のノートをファイルとして書き換えると、画面上の編集内容と衝突するため。
 * 対象はパスで特定し、アクティブなノートかどうかでは選ばない。
 */
export class ObsidianNoteAccess implements NoteAccess {
	constructor(private readonly app: App) {}

	async read(path: string): Promise<string> {
		return this.app.vault.read(this.file(path));
	}

	async edit(path: string, compute: (text: string) => TextEdit[]): Promise<string> {
		const file = this.file(path);
		const view = this.findEditingView(file);
		if (view === undefined) {
			await this.app.vault.process(file, (text) => applyEdits(text, compute(text)));
		} else {
			const { editor } = view;
			// 入力中の内容を含む最新の本文から変更を求め、同じ同期処理の中で適用する。
			const edits = compute(editor.getValue());
			if (edits.length > 0) {
				editor.transaction({
					changes: [...edits]
						.sort((a, b) => b.from - a.from)
						.map((edit) => ({ from: editor.offsetToPos(edit.from), to: editor.offsetToPos(edit.to), text: edit.text })),
				});
				// Editorへの反映だけでは保存完了としない。
				await view.save();
			}
		}
		return this.app.vault.read(file);
	}

	private file(path: string): TFile {
		const file = this.app.vault.getFileByPath(path);
		if (file === null) {
			throw new NoteWriteError('noteMissing', `会議ノート（${path}）が見つかりません。書き込みを止めました。`);
		}
		return file;
	}

	/** 編集モード（ライブプレビューを含む）で開いているビュー。閲覧モードには未保存の入力がないためVault.processで書く。 */
	private findEditingView(file: TFile): MarkdownView | undefined {
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			const { view } = leaf;
			if (view instanceof MarkdownView && view.file?.path === file.path && view.getMode() === 'source') {
				return view;
			}
		}
		return undefined;
	}
}
