import { App, Plugin, PluginSettingTab, Setting, requestUrl, FuzzySuggestModal, TAbstractFile, TFile, TextComponent } from 'obsidian';
import { normalizePath, moment } from 'obsidian';
import { XMLParser } from 'fast-xml-parser';
import {
	getDailyNoteSettings
} from "obsidian-daily-notes-interface";


interface LetterboxdSettings {
	username: string;
	dateFormat: string;
	path: string;
	sort: string;
	simple: boolean;
}

/**
 * Represents one item in the Letterboxd RSS feed
 * 
 * @example
 * ```
 * {
 *  "title": "Ahsoka, 2023 - ★★★★",
 *  "link": "https://letterboxd.com/fleker/film/ahsoka/",
 *  "guid": "letterboxd-review-568742403",
 *  "pubDate": "Thu, 4 Apr 2024 17:28:09 +1300",
 *  "letterboxd:watchedDate": "2024-04-04",
 *  "letterboxd:rewatch": "No",
 *  "letterboxd:filmTitle": "Ahsoka",
 *  "letterboxd:filmYear": 2023,
 *  "letterboxd:memberRating": 4,
 *  "tmdb:tvId": 114461,
 *  "description": "<p><img src=\"https://a.ltrbxd.com/resized/film-poster/1/0/5/5/4/3/0/1055430-ahsoka-0-600-0-900-crop.jpg?v=b8ec715c15\"/></p> <p>...</p> ",
 *  "dc:creator": "fleker"
 * },
 * ```
 */
interface RSSEntry {
	title: string
	link: string
	guid: string
	pubDate: string
	'letterboxd:watchedDate': string
	'letterboxd:rewatch': string
	'letterboxd:filmTitle': string
	'letterboxd:filmYear': number
	'letterboxd:memberRating': number
	'tmdb:tvId': number
	description: string
	'dc:creator': string
}

class FileSelect extends FuzzySuggestModal<TAbstractFile | string> {
	files: TFile[];
	plugin: LetterboxdPlugin;
	values: string[];
	textBox: TextComponent;
	constructor(app: App, plugin: LetterboxdPlugin, textbox: TextComponent) {
		super(app);
		this.files = this.app.vault.getMarkdownFiles();
		this.plugin = plugin;
		this.textBox = textbox;
		this.setPlaceholder('Select or create a file');
		this.scope.register([], 'Tab', e => {
			let child = this.resultContainerEl.querySelector('.suggestion-item.is-selected');
			let text = child ? child.textContent ? child.textContent.split('/') : [] : [];
			let currentInput = this.inputEl.value.split('/');
			let toSlice = text[0] === currentInput[0] ? currentInput.length : 1;
			if (currentInput.length && text[currentInput.length - 1] === currentInput[currentInput.length - 1]) toSlice++;
			this.inputEl.value = text.slice(0, toSlice).join('/');
		});

		this.containerEl.addEventListener('keyup', e => {
			if (e.key !== 'Enter') return;
			if (!this.resultContainerEl.querySelector('.suggestion-item.is-selected') || e.getModifierState('Shift')) {
				this.plugin.settings.path = this.inputEl.value
				this.plugin.saveSettings();
				this.textBox.setValue(this.plugin.settings.path);
				this.close();
			}
		})
	}

	getItems() {
		return this.files.sort((a, b) => b.stat.mtime - a.stat.mtime);
	}

	getItemText(item: TFile): string {
		return item.path;
	}

	onChooseItem(item: TFile, evt: MouseEvent | KeyboardEvent) {
		this.plugin.settings.path = item.path;
		this.plugin.saveSettings();
		this.textBox.setValue(this.plugin.settings.path);
	}
}

const DEFAULT_SETTINGS: LetterboxdSettings = {
	username: '',
	dateFormat: getDailyNoteSettings().format ?? '',
	path: 'Letterboxd Diary',
	sort: 'Old',
	simple: true
}

const decodeHtmlEntities = (text: string) => {
	const txt = document.createElement("textarea");
	txt.innerHTML = text;
	return txt.value;
};

const objToFrontmatter = (obj: Record<string, any>): string => {
	let yamlString = '---\n';
	for (const key in obj) {
		if (Array.isArray(obj[key])) {
			yamlString += `${key}:\n`;
			obj[key].forEach(value => yamlString += `  - ${value}\n`);
		} else {
			yamlString += `${key}: ${obj[key]}\n`;
		}
	}
	return yamlString += '---\n';
}

export default class LetterboxdPlugin extends Plugin {
	settings: LetterboxdSettings;
	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: 'sync',
			name: 'Pull newest entries',
			callback: async () => {
				if (!this.settings.username) {
					throw new Error('Cannot get data for blank username')
				}
				requestUrl(`https://letterboxd.com/${this.settings.username}/rss/`)
					.then(res => res.text)
					.then(async res => {
						const parser = new XMLParser();
						let jObj = parser.parse(res);
						const filename = normalizePath(`${this.settings.path}.md`);
						const diaryMdArr = (jObj.rss.channel.item as RSSEntry[])
							.sort((a, b) => {
								const dateA = new Date(a.pubDate).getTime();
								const dateB = new Date(b.pubDate).getTime();
								return this.settings.sort === 'Old' ? dateA - dateB : dateB - dateA;
							})
							.map((item: RSSEntry) => {
								let description = document.createElement('div');
								description.innerHTML = item.description;
								const imgElement = description.querySelector('img');
								let img = imgElement ? imgElement.src : null;
								let reviewText: string | null = Array.from(description.querySelectorAll('p'))
									.map(p => p.textContent)
									.join('\r > \r > ');
								if (reviewText.contains('Watched on')) reviewText = null;
								const filmTitle = decodeHtmlEntities(item['letterboxd:filmTitle']);
								const watchedDate = this.settings.dateFormat
									? moment(item['letterboxd:watchedDate']).format(this.settings.dateFormat)
									: item['letterboxd:watchedDate'];

								if (this.settings.simple) {
									return item['letterboxd:memberRating'] !== undefined
										? `- Gave [${item['letterboxd:memberRating']} stars to ${filmTitle}](${item['link']}) on [[${watchedDate}]]`
										: `- Watched [${filmTitle}](${item['link']}) on [[${watchedDate}]]`;
								} else {
									return `> [!review] [${filmTitle}](${item['link']}) - [[${watchedDate}]] \r> ${img ? `![${filmTitle}|200](${img}) \r> ${item['letterboxd:memberRating'] ? `**${item['letterboxd:memberRating']} stars**\r>` : ''}` : ''} ${reviewText ? reviewText : ''} \n`;
								}


							})
						const diaryFile = this.app.vault.getFileByPath(filename)
						if (diaryFile === null) {
							let pathArray = this.settings.path.split('/');
							pathArray.pop();
							if (pathArray.length > 1) this.app.vault.createFolder(pathArray.join('/'));
							this.app.vault.create(filename, `${diaryMdArr.join('\n')}`);
						} else {
							let frontMatter = '';
							this.app.fileManager.processFrontMatter(diaryFile, (data) => {
								if (Object.keys(data).length) frontMatter = objToFrontmatter(data);
							});
							this.app.vault.process(diaryFile, (data) => {
								let diaryContentsArr = data.split('\n');
								if (frontMatter.length) {
									let count = 0;
									while (diaryContentsArr.length > 0) {
										let firstElement = diaryContentsArr.shift();
										if (firstElement === '---') {
											count++;
											if (count === 2) break;
										}
									}
								}
								const diaryContentsSet = new Set(diaryContentsArr);
								const newEntries = diaryMdArr.filter((entry: string) => !diaryContentsSet.has(entry));
								const finalEntries = this.settings.sort === 'Old'
									? [...diaryContentsArr, ...newEntries]
									: [...newEntries, ...diaryContentsArr];
								return frontMatter.length ? frontMatter + finalEntries.join('\n') : finalEntries.join('\n');
							})
						}
					})
			},
		})

		this.addSettingTab(new LetterboxdSettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class LetterboxdSettingTab extends PluginSettingTab {
	plugin: LetterboxdPlugin;
	settings: any

	constructor(app: App, plugin: LetterboxdPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		this.settings = this.plugin.loadData()

		containerEl.empty();

		new Setting(containerEl)
			.setName('Letterboxd username')
			.setDesc('The username to fetch data from. This account must be public.')
			.addText((component) => {
				component.setPlaceholder('username')
				component.setValue(this.plugin.settings.username)
				component.onChange(async (value) => {
					this.plugin.settings.username = value
					await this.plugin.saveSettings()
				})
			})

		let fileSelectorText: TextComponent;
		new Setting(containerEl)
			.setName('Set Note')
			.setDesc('Select the file to save your Letterboxd to. If it does not exist, it will be created.')
			.addText((component) => {
				component.setPlaceholder('')
				component.setValue(this.plugin.settings.path)
				component.onChange(async (value) => {
					this.plugin.settings.path = value
					await this.plugin.saveSettings()
				});
				fileSelectorText = component;
			})
			.addButton((component) => {
				component.setButtonText('Select Note')
				component.onClick(async () => {
					new FileSelect(this.app, this.plugin, fileSelectorText).open();
				})
			});

		new Setting(containerEl)
			.setName('Sort by Date')
			.setDesc('Select the order to list your diary entries.')
			.addDropdown((component) => {
				component.addOption('Old', 'Oldest First');
				component.addOption('New', 'Newest First');
				component.setValue(this.plugin.settings.sort)
				component.onChange(async (value) => {
					this.plugin.settings.sort = value
					await this.plugin.saveSettings()
				})
			})

		new Setting(containerEl)
			.setName('Simple')
			.setDesc('Select whether to use simpler formatting.')
			.addToggle((component) => {
				component.setValue(this.plugin.settings.simple)
				component.onChange(async (value) => {
					this.plugin.settings.simple = value
					await this.plugin.saveSettings()
				})
			})
	}
}