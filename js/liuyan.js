/* ======= 工具函数 ======= */
const fmtTime = ts => new Date(ts).toLocaleString();
const $ = s => document.querySelector(s);

/* ======= IndexedDB 封装 ======= */
class MessageBoardDB {
	constructor() { this.dbName = 'MessageBoardDB'; this.version = 2; this.db = null; }
	async init() {
		return new Promise((resolve, reject) => {
			const req = indexedDB.open(this.dbName, this.version);
			req.onerror = () => reject(req.error);
			req.onupgradeneeded = (e) => {
				const db = e.target.result;
				if (!db.objectStoreNames.contains('messages')) {
					const store = db.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
					store.createIndex('createdAt', 'createdAt', { unique: false });
				}
			};
			req.onsuccess = () => { this.db = req.result; resolve(this.db); };
		});
	}
	async addMessage({ name, text, createdAt, avatar }) {
		const tx = this.db.transaction(['messages'], 'readwrite');
		const store = tx.objectStore('messages');
		return new Promise((resolve, reject) => {
			const req = store.add({ name, text, createdAt, avatar });
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	}
	async getAllMessages() {
		const tx = this.db.transaction(['messages'], 'readonly');
		const store = tx.objectStore('messages');
		return new Promise((resolve, reject) => {
			const req = store.getAll();
			req.onsuccess = () => {
				const list = (req.result || []).sort((a,b)=> b.createdAt - a.createdAt);
				resolve(list);
			};
			req.onerror = () => reject(req.error);
		});
	}
	async clearAll() {
		const tx = this.db.transaction(['messages'], 'readwrite');
		const store = tx.objectStore('messages');
		return new Promise((resolve, reject) => {
			const req = store.clear();
			req.onsuccess = () => resolve();
			req.onerror = () => reject(req.error);
		});
	}
}
const DB = new MessageBoardDB();

/*随机头像*/
const avatars = [
	'/img/img1.jpg',
	'/img/img2.jpg',
	'/img/img3.jpg',
	'/img/img4.jpg',
	'/img/img5.jpg',
	'/img/img6.jpg',
	'/img/img7.jpg'
];
function randomAvatar() {
	return avatars[Math.floor(Math.random() * avatars.length)];
}

/* ======= 渲染 ======= */
function renderList(items) {
	const wrap = $('.list');
	if (!wrap) return;

	wrap.innerHTML = '';
	if (!items.length) {
		const empty = document.createElement('div');
		empty.className = 'item yining bg';
		empty.style.opacity = '0.85';
		empty.innerHTML = `
      <div class="top flexsb">
        <div>
          <img src="../img/img.jpg" alt="" />
          <div>系统提示</div>
        </div>
        <span>暂无留言</span>
      </div>
      <div class="btm">快来发布第一条留言吧～</div>
    `;
		wrap.appendChild(empty);
		return;
	}
	for (const m of items) {
		wrap.appendChild(makeItemNode(m));
	}
}

function makeItemNode(msg) {
	const item = document.createElement('div');
	item.className = 'item yining bg';

	const top = document.createElement('div');
	top.className = 'top flexsb';

	const left = document.createElement('div');
	const avatar = document.createElement('img');
	avatar.src = msg.avatar || 'img/img.jpg';   // 回退到存在的文件
	avatar.alt = '';

	const nameDiv = document.createElement('div');
	nameDiv.textContent = msg.name;

	left.appendChild(avatar);
	left.appendChild(nameDiv);

	const timeSpan = document.createElement('span');
	timeSpan.textContent = `发布于:${fmtTime(msg.createdAt)}`;

	top.appendChild(left);
	top.appendChild(timeSpan);

	const btm = document.createElement('div');
	btm.className = 'btm';
	btm.textContent = msg.text;

	item.appendChild(top);
	item.appendChild(btm);
	return item;
}

/* ======= 事件绑定 ======= */
function bindUI() {
	const btnOK = document.querySelector('.OK');
	const btnClear = document.querySelector('.clear');
	const iptName = document.querySelector('.name');
	const iptText = document.querySelector('.text');

	// 记住昵称
	const savedNick = localStorage.getItem('mb_nick');
	if (savedNick && iptName) iptName.value = savedNick;

	btnOK && btnOK.addEventListener('click', async () => {
		const name = (iptName?.value || '').trim();
		const text = (iptText?.value || '').trim();
		if (!name || !text) { alert('输入框不能为空！'); return; }

		try {
			const avatar = randomAvatar();
			await DB.addMessage({ name, text, createdAt: Date.now(), avatar });
			localStorage.setItem('mb_nick', name);
			const all = await DB.getAllMessages();
			renderList(all);
			iptText.value = '';
		} catch (e) {
			console.error(e);
			alert('保存失败，请重试');
		}
	});

	btnClear && btnClear.addEventListener('click', () => {
		if (iptName) iptName.value = '';
		if (iptText) iptText.value = '';
	});

	// 新增：清空数据库按钮
	const btnClearDB = document.createElement('button');
	btnClearDB.textContent = '重置';
	btnClearDB.className = 'yining bg';
	btnClearDB.style.cssText =
		'border:none;height:45px;border-radius:10px;width:40%;color:#fff;font-weight:bold;font-size:16px;letter-spacing:4px;';
	document.querySelector('.btn.flexsb')?.appendChild(btnClearDB);

	btnClearDB.addEventListener('click', async () => {
		if (!confirm('⚠️ 确定要清空所有留言吗？此操作无法恢复！')) return;
		await DB.clearAll();
		renderList([]);
		alert('留言板已清空');
	});
}

/* ======= 启动（关键） ======= */
document.addEventListener('DOMContentLoaded', async () => {
	try {
		await DB.init();                 // 初始化数据库
		const list = await DB.getAllMessages(); // 加载历史记录
		renderList(list);                // 渲染
		bindUI();                        // 绑定按钮事件
	} catch (e) {
		console.error('数据库初始化失败：', e);
		alert('本地数据库不可用，留言将不会持久保存。');
		bindUI(); // 即使失败也绑定基本交互
	}
});
