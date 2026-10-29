import { App, Notice, Plugin, PluginSettingTab, SecretComponent, Setting, TextComponent } from 'obsidian';
import {
	getModelEntry,
	getOllamaModelLimits,
	type LMeetscribeSettings,
	OLLAMA_DEFAULT_CHUNK_CHARS,
	OLLAMA_DEFAULT_CONTEXT_TOKENS,
	withModelEntry,
} from './settings';
import {
	checkExecutableFile,
	checkReadableDirectory,
	validateChunkSeconds,
	validateOllamaUrl,
	validateOpenAIModelLimits,
	validatePositiveInteger,
	validateSilenceThresholdDbfs,
	validateSpeakerLabel,
	validateWhisperModelLanguage,
	type WhisperLanguage,
} from './validation';

export interface SettingsHost extends Plugin {
	settings: LMeetscribeSettings;
	saveSettings(): Promise<void>;
}

/** Ollamaのモデル詳細のうち、設定画面で示すもの。 */
export interface OllamaModelInfo {
	local: boolean;
	contextLength?: number;
	thinking: boolean;
}

/** モデル一覧の取得処理。省略した取得処理は、再読み込みボタンを無効にする。 */
export interface ModelListSources {
	whisper?: (modelDir: string) => Promise<string[]>;
	ollama?: (url: string) => Promise<string[]>;
	ollamaDetails?: (url: string, model: string) => Promise<OllamaModelInfo>;
}

export class LMeetscribeSettingTab extends PluginSettingTab {
	private whisperModels: string[] = [];
	private ollamaModels: string[] = [];
	/** 選択中のOllamaモデルの詳細。URL・モデルが変わったら取り直す。 */
	private ollamaInfo: { key: string; info?: OllamaModelInfo; error?: string } | undefined;

	constructor(
		app: App,
		private readonly host: SettingsHost,
		private readonly modelSources: ModelListSources,
	) {
		super(app, host);
	}

	private get settings(): LMeetscribeSettings {
		return this.host.settings;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.displayWhisper(containerEl);
		this.displayRecording(containerEl);
		this.displaySummary(containerEl);
		this.displayOpenAI(containerEl);
		this.displayOllama(containerEl);
		this.displayOutput(containerEl);
	}

	private displayWhisper(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('文字起こし').setHeading();

		this.addPathSetting(containerEl, '実行ファイル', 'whisper-cliの絶対パス。', this.settings.whisper.executablePath, checkExecutableFile, async (value) => {
			this.settings.whisper.executablePath = value;
			await this.save();
		});

		this.addPathSetting(containerEl, 'モデルフォルダ', 'ggml形式のモデルを置いたフォルダの絶対パス。', this.settings.whisper.modelDir, checkReadableDirectory, async (value) => {
			this.settings.whisper.modelDir = value;
			await this.save();
		});

		const modelSetting = new Setting(containerEl).setName('使用モデル').setDesc('モデルフォルダ内のモデルから選びます。');
		const modelError = createErrorEl(modelSetting);
		modelSetting
			.addDropdown((dropdown) => {
				addOptions(dropdown.selectEl, this.whisperModels, this.settings.whisper.model, '未選択');
				dropdown.setValue(this.settings.whisper.model).onChange(async (value) => {
					const error = validateWhisperModelLanguage(value, this.settings.whisper.language);
					setError(modelError, error);
					if (error !== undefined) {
						dropdown.setValue(this.settings.whisper.model);
						return;
					}
					this.settings.whisper.model = value;
					await this.save();
				});
			})
			.addExtraButton((button) => {
				const listModels = this.modelSources.whisper;
				button
					.setIcon('refresh-cw')
					.setTooltip(listModels ? '一覧を再読み込み' : 'モデル一覧の取得は未実装です')
					.setDisabled(listModels === undefined)
					.onClick(async () => {
						if (listModels === undefined) {
							return;
						}
						this.whisperModels = await this.loadModelList(() => listModels(this.settings.whisper.modelDir));
						this.display();
					});
			});

		const languageSetting = new Setting(containerEl).setName('言語');
		const languageError = createErrorEl(languageSetting);
		languageSetting.addDropdown((dropdown) =>
			dropdown
				.addOptions({ ja: '日本語（ja）', en: '英語（en）', auto: '自動判定（auto）' })
				.setValue(this.settings.whisper.language)
				.onChange(async (value) => {
					const language = value as WhisperLanguage;
					const error = validateWhisperModelLanguage(this.settings.whisper.model, language);
					setError(languageError, error);
					if (error !== undefined) {
						dropdown.setValue(this.settings.whisper.language);
						return;
					}
					this.settings.whisper.language = language;
					await this.save();
				}),
		);

		this.addNumberSetting(containerEl, 'チャンク長（秒）', '', this.settings.whisper.chunkSeconds, validateChunkSeconds, async (value) => {
			this.settings.whisper.chunkSeconds = value;
			await this.save();
		});

		this.addNumberSetting(
			containerEl,
			'無音しきい値（dBFS）',
			'RMSがこの値以下のチャンクを無音として扱います。',
			this.settings.whisper.silenceThresholdDbfs,
			validateSilenceThresholdDbfs,
			async (value) => {
				this.settings.whisper.silenceThresholdDbfs = value;
				await this.save();
			},
		);
	}

	private displayRecording(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('録音').setHeading();

		// 設定画面ではデバイス一覧を取得せず、既定値だけを選べる。個別のデバイスは会議ブロックで選ぶ。
		new Setting(containerEl)
			.setName('既定マイク')
			.addDropdown((dropdown) => {
				addOptions(dropdown.selectEl, [], this.settings.recording.microphoneDeviceUid, '録音開始時のシステム既定入力');
				dropdown.setValue(this.settings.recording.microphoneDeviceUid).onChange(async (value) => {
					this.settings.recording.microphoneDeviceUid = value;
					await this.save();
				});
			});

		new Setting(containerEl)
			.setName('既定の相手音声対象')
			.addDropdown((dropdown) => {
				addOptions(dropdown.selectEl, [], this.settings.recording.outputDeviceUid, 'すべての出力');
				dropdown.setValue(this.settings.recording.outputDeviceUid).onChange(async (value) => {
					this.settings.recording.outputDeviceUid = value;
					await this.save();
				});
			});

	}

	private displaySummary(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('要約').setHeading();

		new Setting(containerEl)
			.setName('実行先')
			.setDesc('失敗時に別の実行先へ自動で切り替えることはありません。')
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({ openai: 'OpenAI API', ollama: 'Ollama（このMac）' })
					.setValue(this.settings.summary.provider)
					.onChange(async (value) => {
						this.settings.summary.provider = value === 'ollama' ? 'ollama' : 'openai';
						await this.save();
					}),
			);

		new Setting(containerEl)
			.setName('停止後の自動要約')
			.setDesc('オフでも手動で要約できます。')
			.addToggle((toggle) =>
				toggle.setValue(this.settings.summary.autoSummarize).onChange(async (value) => {
					this.settings.summary.autoSummarize = value;
					await this.save();
				}),
			);
	}

	private displayOpenAI(containerEl: HTMLElement): void {
		const openai = this.settings.summary.openai;
		new Setting(containerEl).setName('OpenAI').setHeading();

		// キーの値はSecretStorageに置き、ここでは参照IDだけを受け取って保存する。
		new Setting(containerEl)
			.setName('APIキー')
			.setDesc('保存済みのシークレットから選びます。')
			.addComponent((el) =>
				new SecretComponent(this.app, el).setValue(openai.apiKeySecretId).onChange(async (value) => {
					openai.apiKeySecretId = value;
					await this.save();
				}),
			);

		const modelSetting = new Setting(containerEl).setName('モデル').setDesc('Responses APIに対応したモデル名を入力します。');
		let contextText: TextComponent | undefined;
		let reserveText: TextComponent | undefined;
		const limitsSetting = new Setting(containerEl);
		const limitsError = createErrorEl(limitsSetting);

		const refreshLimits = (): void => {
			const limits = getModelEntry(openai.modelLimits, openai.model);
			const disabled = openai.model === '';
			contextText?.setValue(limits ? String(limits.contextTokens) : '').setDisabled(disabled);
			reserveText?.setValue(limits ? String(limits.outputReserveTokens) : '').setDisabled(disabled);
			setError(limitsError, disabled ? undefined : validateOpenAIModelLimits(limits));
		};

		const saveLimits = async (): Promise<void> => {
			const limits = {
				contextTokens: parseNumber(contextText?.getValue() ?? ''),
				outputReserveTokens: parseNumber(reserveText?.getValue() ?? ''),
			};
			const error = validateOpenAIModelLimits(limits);
			setError(limitsError, error);
			if (error !== undefined) {
				return;
			}
			openai.modelLimits = withModelEntry(openai.modelLimits, openai.model, limits);
			await this.save();
		};

		// モデル名の入力ごとに再描画すると入力欄のフォーカスが外れるため、上限欄だけを更新する。
		modelSetting.addText((text) =>
			text.setValue(openai.model).onChange(async (value) => {
				openai.model = value.trim();
				refreshLimits();
				await this.save();
			}),
		);

		limitsSetting
			.setName('コンテキスト長・出力予約トークン数')
			.setDesc('選択中のモデルごとに保存します。公式の上限を基に入力してください。')
			.addText((text) => {
				contextText = text.setPlaceholder('コンテキスト長').onChange(saveLimits);
			})
			.addText((text) => {
				reserveText = text.setPlaceholder('出力予約').onChange(saveLimits);
			});
		refreshLimits();
	}

	private displayOllama(containerEl: HTMLElement): void {
		const ollama = this.settings.summary.ollama;
		new Setting(containerEl).setName('Ollama').setHeading();

		this.addTextSetting(containerEl, 'URL', 'このMacのループバックアドレスだけを指定できます。', ollama.url, validateOllamaUrl, async (value) => {
			ollama.url = value.trim();
			await this.save();
		});

		new Setting(containerEl)
			.setName('モデル')
			.setDesc('インストール済みのローカルモデルから選びます。')
			.addDropdown((dropdown) => {
				addOptions(dropdown.selectEl, this.ollamaModels, ollama.model, '未選択');
				dropdown.setValue(ollama.model).onChange(async (value) => {
					ollama.model = value;
					await this.save();
					this.display();
				});
			})
			.addExtraButton((button) => {
				const listModels = this.modelSources.ollama;
				button
					.setIcon('refresh-cw')
					.setTooltip(listModels ? '一覧を再読み込み' : 'モデル一覧の取得は未実装です')
					.setDisabled(listModels === undefined)
					.onClick(async () => {
						if (listModels === undefined) {
							return;
						}
						this.ollamaModels = await this.loadModelList(() => listModels(ollama.url));
						this.display();
					});
			});

		if (ollama.model !== '') {
			this.displayOllamaInfo(containerEl);
			const limits = getOllamaModelLimits(ollama, ollama.model);
			const override = getModelEntry(ollama.modelOverrides, ollama.model);
			const saveOverride = async (key: 'contextTokens' | 'chunkChars', value: number | undefined): Promise<void> => {
				const next = { ...getModelEntry(ollama.modelOverrides, ollama.model), [key]: value };
				const hasValue = next.contextTokens !== undefined || next.chunkChars !== undefined;
				ollama.modelOverrides = withModelEntry(ollama.modelOverrides, ollama.model, hasValue ? next : undefined);
				await this.save();
			};

			this.addOptionalIntegerSetting(
				containerEl,
				'コンテキスト長（トークン）',
				`現在の値: ${limits.contextTokens}。空欄で初期値（${OLLAMA_DEFAULT_CONTEXT_TOKENS}）に戻します。`,
				override?.contextTokens,
				OLLAMA_DEFAULT_CONTEXT_TOKENS,
				(value) => saveOverride('contextTokens', value),
			);
			this.addOptionalIntegerSetting(
				containerEl,
				'分割文字数',
				`現在の値: ${limits.chunkChars}。空欄で初期値（${OLLAMA_DEFAULT_CHUNK_CHARS}）に戻します。`,
				override?.chunkChars,
				OLLAMA_DEFAULT_CHUNK_CHARS,
				(value) => saveOverride('chunkChars', value),
			);
		}

		// thinkingに対応しないモデルには指定を送らないため、切り替えても効果がない。
		const thinkingSupported = this.currentOllamaInfo()?.thinking;
		new Setting(containerEl)
			.setName('Thinkingモード')
			.setDesc(
				thinkingSupported === false
					? '選択中のモデルはthinkingに対応していません（非対応）。'
					: 'OFFでもthinkingを無効にできないモデルがあります。出力に影響する場合はモデルを変えてください。',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(ollama.thinking)
					.setDisabled(thinkingSupported === false)
					.onChange(async (value) => {
						ollama.thinking = value;
						await this.save();
					}),
			);
	}

	private currentOllamaInfo(): OllamaModelInfo | undefined {
		const { url, model } = this.settings.summary.ollama;
		return this.ollamaInfo?.key === `${url}\n${model}` ? this.ollamaInfo.info : undefined;
	}

	/** 選択中のモデルがローカルで実行されるか、最大のコンテキスト長を示す。取得は非同期で行い、終わったら描き直す。 */
	private displayOllamaInfo(containerEl: HTMLElement): void {
		const { url, model } = this.settings.summary.ollama;
		const source = this.modelSources.ollamaDetails;
		const key = `${url}\n${model}`;
		const setting = new Setting(containerEl).setName('モデル情報');
		if (source === undefined) {
			return;
		}
		if (this.ollamaInfo?.key !== key) {
			this.ollamaInfo = { key };
			setting.setDesc('取得中…');
			void source(url, model).then(
				(info) => {
					if (this.ollamaInfo?.key === key) {
						this.ollamaInfo.info = info;
						this.display();
					}
				},
				(error: unknown) => {
					if (this.ollamaInfo?.key === key) {
						this.ollamaInfo.error = error instanceof Error ? error.message : String(error);
						this.display();
					}
				},
			);
			return;
		}
		const { info, error } = this.ollamaInfo;
		if (error !== undefined) {
			setting.setDesc(`取得できません: ${error}`);
		} else if (info === undefined) {
			setting.setDesc('取得中…');
		} else if (!info.local) {
			setting.setDesc('ローカルで実行されることを確認できないモデルです。要約には使えません。ローカルのモデルを選んでください。');
		} else {
			const max = info.contextLength === undefined ? '不明' : String(info.contextLength);
			setting.setDesc(`ローカルで実行されます。モデルの最大コンテキスト長: ${max}（設定値が上回る場合は最大値を使います）。thinking: ${info.thinking ? '対応' : '非対応'}。`);
		}
		setting.addExtraButton((button) =>
			button
				.setIcon('refresh-cw')
				.setTooltip('モデル情報を再取得')
				.onClick(() => {
					this.ollamaInfo = undefined;
					this.display();
				}),
		);
	}

	private displayOutput(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('表示').setHeading();

		this.addTextSetting(containerEl, '話者ラベル（自分）', '', this.settings.display.selfLabel, validateSpeakerLabel, async (value) => {
			this.settings.display.selfLabel = value.trim();
			await this.save();
		});

		this.addTextSetting(containerEl, '話者ラベル（相手）', '', this.settings.display.otherLabel, validateSpeakerLabel, async (value) => {
			this.settings.display.otherLabel = value.trim();
			await this.save();
		});

		new Setting(containerEl).setName('タイムスタンプを表示').addToggle((toggle) =>
			toggle.setValue(this.settings.display.showTimestamps).onChange(async (value) => {
				this.settings.display.showTimestamps = value;
				await this.save();
			}),
		);
	}

	/** 検証に通った値だけを保存し、通らなければ理由を表示する。 */
	private addTextSetting(
		containerEl: HTMLElement,
		name: string,
		desc: string,
		value: string,
		validate: (value: string) => string | undefined,
		save: (value: string) => Promise<void>,
	): void {
		const setting = new Setting(containerEl).setName(name).setDesc(desc);
		const errorEl = createErrorEl(setting);
		setting.addText((text) =>
			text.setValue(value).onChange(async (input) => {
				const error = validate(input);
				setError(errorEl, error);
				if (error === undefined) {
					await save(input);
				}
			}),
		);
	}

	private addNumberSetting(
		containerEl: HTMLElement,
		name: string,
		desc: string,
		value: number,
		validate: (value: number) => string | undefined,
		save: (value: number) => Promise<void>,
	): void {
		this.addTextSetting(containerEl, name, desc, String(value), (input) => validate(parseNumber(input)), (input) => save(parseNumber(input)));
	}

	private addOptionalIntegerSetting(
		containerEl: HTMLElement,
		name: string,
		desc: string,
		value: number | undefined,
		placeholder: number,
		save: (value: number | undefined) => Promise<void>,
	): void {
		const setting = new Setting(containerEl).setName(name).setDesc(desc);
		const errorEl = createErrorEl(setting);
		setting.addText((text) =>
			text
				.setPlaceholder(String(placeholder))
				.setValue(value === undefined ? '' : String(value))
				.onChange(async (input) => {
					if (input.trim() === '') {
						setError(errorEl, undefined);
						await save(undefined);
						return;
					}
					const error = validatePositiveInteger(parseNumber(input), name);
					setError(errorEl, error);
					if (error === undefined) {
						await save(parseNumber(input));
					}
				}),
		);
	}

	/**
	 * パスはファイルシステムの状態で可否が変わるため、確認できなくても保存し、結果を表示する。
	 * 録音開始時にも同じ確認を行う。
	 */
	private addPathSetting(
		containerEl: HTMLElement,
		name: string,
		desc: string,
		value: string,
		check: (path: string) => Promise<string | undefined>,
		save: (value: string) => Promise<void>,
	): void {
		const setting = new Setting(containerEl).setName(name).setDesc(desc);
		const errorEl = createErrorEl(setting);
		// 入力が続く間に古い確認結果で表示を上書きしないよう、最新の要求だけを反映する。
		let latestRequest = 0;
		const showCheck = async (path: string): Promise<void> => {
			const request = ++latestRequest;
			const error = await check(path);
			if (request === latestRequest) {
				setError(errorEl, error);
			}
		};
		setting.addText((text) =>
			text.setValue(value).onChange(async (input) => {
				const path = input.trim();
				await save(path);
				await showCheck(path);
			}),
		);
		void showCheck(value);
	}

	private async loadModelList(load: () => Promise<string[]>): Promise<string[]> {
		try {
			return await load();
		} catch (error) {
			new Notice(`モデル一覧を取得できませんでした: ${error instanceof Error ? error.message : String(error)}`);
			return [];
		}
	}

	private async save(): Promise<void> {
		try {
			await this.host.saveSettings();
		} catch (error) {
			new Notice(`設定を保存できませんでした: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

function parseNumber(input: string): number {
	return input.trim() === '' ? Number.NaN : Number(input.trim());
}

function createErrorEl(setting: Setting): HTMLElement {
	return setting.descEl.createDiv({ cls: 'lms-setting-error' });
}

function setError(errorEl: HTMLElement, message: string | undefined): void {
	errorEl.setText(message ?? '');
}

/** 一覧にない保存済みの値も選択肢に残し、取得前に設定が消えたように見せない。 */
function addOptions(selectEl: HTMLSelectElement, values: string[], current: string, emptyLabel: string): void {
	const options = new Set(values);
	if (current !== '') {
		options.add(current);
	}
	selectEl.createEl('option', { value: '', text: emptyLabel });
	for (const value of options) {
		selectEl.createEl('option', { value, text: value });
	}
}
