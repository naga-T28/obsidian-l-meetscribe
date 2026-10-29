import type { SessionSnapshot } from '../session/RecordingSession';
import type { FailureStage, SessionFailure, SessionState } from '../session/records';

// 会議ブロックとステータスバーで共通の表示文言。

/** 相手トラックの無音が続いたら確認を促す時間。システム音声の許可がないと、エラーにならず無音になるため。 */
export const OTHER_SILENCE_WARNING_MS = 60_000;

const STATE_LABELS: Record<SessionState, string> = {
	preparing: '開始準備中',
	recording: '録音中',
	draining: '文字起こし待ち',
	summarizing: '要約中',
	completed: '完了',
	error: 'エラー',
};

const STAGE_LABELS: Record<FailureStage, string> = {
	start: '録音の開始',
	recording: '録音',
	transcription: '文字起こし',
	note: 'ノートへの反映',
	storage: '作業データの保存',
};

// 録音ヘルパーとNode.jsのエラーコードごとの次の操作。
const CODE_GUIDANCE: Record<string, string> = {
	microphoneDenied: 'システム設定の「プライバシーとセキュリティ」→「マイク」でObsidianを許可し、Obsidianを再起動してください。',
	deviceNotFound: '選んだデバイスが見つかりません。デバイス一覧を再読み込みして選び直してください。',
	deviceDisconnected: '録音中にデバイスが切断されました。接続を確認してから、新しい会議ブロックで録音してください。',
	formatChanged: '録音中にデバイスの形式が変わりました。デバイスの設定を確認してから、新しい会議ブロックで録音してください。',
	trackStalled: 'デバイスから音声が届かなくなりました。接続と、他のアプリが使用していないかを確認してください。',
	startFailed: 'デバイスを開始できませんでした。他のアプリが使用していないかを確認してください。',
	startTimeout: 'デバイスの開始が時間内に終わりませんでした。デバイスを接続し直すか、Macを再起動してください。',
	heartbeatTimeout: '録音ヘルパーとの通信が途絶えました。確定済みのチャンクは残っています。',
	writeFailed: '作業領域に書き込めません。ディスクの空き容量を確認してください。',
	workDirUnavailable: '作業領域を使用できません。ディスクの空き容量とアクセス権を確認してください。',
	ENOSPC: 'ディスクの空き容量が不足しています。空きを確保してから再試行してください。',
	// ノートへの反映（NoteWriteError）。文字起こしの結果は作業領域に残っている。
	noteMissing: '会議ノートが削除されたか見つかりません。文字起こしの結果は作業領域に残っています。',
	blockMissing: '会議ブロックが削除されたか、IDの行が変更されています。ブロックを元に戻してから「再試行」を押してください。',
	duplicateBlock: '同じIDの会議ブロックが複数あります。複製したブロックを削除してから「再試行」を押してください。',
	sessionMismatch: 'この会議ブロックには別の録音が記録されています。新しい空のlmsブロックを使ってください。',
	boundaryBroken: '出力領域の管理コメント（<!-- lms:... -->）を元に戻してから「再試行」を押してください。',
	notSaved: 'ノートの保存を確認できませんでした。ノートを開いたまま「再試行」を押してください。',
};

const STAGE_GUIDANCE: Record<FailureStage, string> = {
	start: '設定とデバイスを確認して、もう一度開始してください。',
	recording: '確定済みのチャンクは作業領域に残っています。',
	transcription: '「再試行」で保存済みのデータから処理を再開できます。',
	note: 'ノートと会議ブロックを確認してから「再試行」を押してください。文字起こしの結果は作業領域に残っています。',
	storage: 'ディスクの空き容量とアクセス権を確認して、「再試行」を押してください。',
};

export function stateLabel(state: SessionState): string {
	return STATE_LABELS[state];
}

/** 失敗した処理・原因・次の操作の順に並べ、利用者が次に何をすればよいか分かるようにする。 */
export function describeFailure(failure: SessionFailure): { summary: string; guidance: string } {
	const guidance = (failure.code !== undefined ? CODE_GUIDANCE[failure.code] : undefined) ?? STAGE_GUIDANCE[failure.stage];
	return { summary: `${STAGE_LABELS[failure.stage]}に失敗しました: ${failure.message}`, guidance };
}

export function otherSilenceWarning(snapshot: SessionSnapshot): string | undefined {
	if (snapshot.state !== 'recording' || snapshot.otherSilentMs < OTHER_SILENCE_WARNING_MS) {
		return undefined;
	}
	// システム音声の許可の状態を読む公開APIがなく、無音だけでは拒否と断定できない。確認すべき点を並べる。
	return '相手の音声が60秒以上無音です。相手音声の対象、会議アプリの再生状態、システム設定でのシステム音声の録音の許可を確認してください。';
}

export function noteProblemWarning(snapshot: SessionSnapshot): string | undefined {
	if (snapshot.noteProblem === undefined || snapshot.state === 'error') {
		return undefined;
	}
	return `ノートへの反映を止めています: ${snapshot.noteProblem} 録音と文字起こしは続けています。`;
}

export function diskSpaceWarning(snapshot: SessionSnapshot): string | undefined {
	if (!snapshot.diskSpaceLow || snapshot.state === 'completed') {
		return undefined;
	}
	return '作業領域の空き容量が不足したため録音を停止しました。録音済みの音声は文字起こしを続けます。空き容量を確保してください。';
}

/** 経過時間をH:MM:SSで表す。 */
export function formatElapsed(startedAt: string, now: Date): string {
	const seconds = Math.max(0, Math.floor((now.getTime() - Date.parse(startedAt)) / 1000));
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
