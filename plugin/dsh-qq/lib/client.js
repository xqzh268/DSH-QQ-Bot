/**
 * dsh-qq 客户端半：主界面里的「QQ」面板。
 *
 * 直接以 DSH 客户端模块格式书写（window.__ModuleLoader__），无需构建：
 *   - React 从 require('react') 拿
 *   - 通过 ctx.slots 注册两个扩展点：
 *       sidebar.panellist  侧边栏「工作区」上方的入口行（图标 + 文字）
 *       main               点击入口后显示在主界面的面板（key 与入口 id 相同）
 *   - 通过本插件自己的 /dsh-qq/api/* 与宿主通信（带连接围栏）
 *   - 配色全部取自宿主主题变量 --dsw-alias-*，并给了回退值，深浅色都跟随应用
 */
window.__ModuleLoader__.load({
	id: 'dsh-qq',
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		const react = require('react');
		const h = react.createElement;

		const inject = ['slots', 'locale'];
		const NS = 'dsh-qq';
		const PANEL_ID = 'dsh-qq';

		const css = `
.qq_app{--qq-bg:var(--dsw-alias-bg-base,Canvas);--qq-layer:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.07));--qq-line:var(--dsw-alias-border-l2,rgba(128,128,128,.22));--qq-line2:var(--dsw-alias-border-l3,rgba(128,128,128,.4));--qq-text:var(--dsw-alias-label-primary,CanvasText);--qq-sub:var(--dsw-alias-label-secondary,rgba(128,128,128,1));--qq-faint:var(--dsw-alias-label-tertiary,rgba(128,128,128,.8));--qq-hover:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));--qq-accent:var(--dsw-alias-state-business-primary,#4d6bfe);--qq-ok:#2f9e63;--qq-warn:var(--dsw-alias-state-warn-label,#d9822b);--qq-err:var(--dsw-alias-state-error-primary,#e5484d);
position:relative;container-type:inline-size;box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;color:var(--qq-text);background:var(--qq-bg);font-size:13px;line-height:1.5;color-scheme:light dark}
.qq_app *{box-sizing:border-box}

/* ---------- 顶栏 ---------- */
.qq_head{flex:none;display:flex;align-items:center;gap:14px;padding:16px 28px 14px;padding-inline-start:max(28px,var(--dsh-frame-leading-clearance,0px));border-bottom:1px solid var(--qq-line)}
.qq_logo{flex:none;width:38px;height:38px;border-radius:11px;display:grid;place-items:center;color:#fff;background:linear-gradient(135deg,var(--qq-accent),color-mix(in srgb,var(--qq-accent) 55%,#b04dfe));box-shadow:0 4px 14px -4px color-mix(in srgb,var(--qq-accent) 60%,transparent)}
.qq_head_t{min-width:0;display:flex;flex-direction:column;gap:1px}
.qq_head_title{font-size:16px;font-weight:650;letter-spacing:.2px}
.qq_head_sub{font-size:12px;color:var(--qq-sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qq_head_r{margin-inline-start:auto;display:flex;align-items:center;gap:10px}

/* ---------- 状态胶囊 ---------- */
.qq_pill{display:inline-flex;align-items:center;gap:7px;height:26px;padding:0 11px;border-radius:999px;font-size:12px;border:1px solid var(--qq-line);background:var(--qq-layer);color:var(--qq-sub);white-space:nowrap}
.qq_pill .dot{width:7px;height:7px;border-radius:50%;background:var(--qq-faint)}
.qq_pill.ok{color:var(--qq-ok);border-color:color-mix(in srgb,var(--qq-ok) 35%,transparent);background:color-mix(in srgb,var(--qq-ok) 9%,transparent)}
.qq_pill.ok .dot{background:var(--qq-ok);box-shadow:0 0 0 0 color-mix(in srgb,var(--qq-ok) 60%,transparent);animation:qq_pulse 2s infinite}
.qq_pill.warn{color:var(--qq-warn);border-color:color-mix(in srgb,var(--qq-warn) 35%,transparent);background:color-mix(in srgb,var(--qq-warn) 9%,transparent)}
.qq_pill.warn .dot{background:var(--qq-warn)}
@keyframes qq_pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--qq-ok) 55%,transparent)}70%{box-shadow:0 0 0 6px transparent}100%{box-shadow:0 0 0 0 transparent}}

/* ---------- 主体：左导航 + 右内容 ---------- */
.qq_body{flex:1;min-height:0;display:flex}
.qq_nav{flex:none;width:204px;padding:14px 10px;border-inline-end:1px solid var(--qq-line);overflow-y:auto;display:flex;flex-direction:column;gap:2px}
.qq_nav_item{position:relative;display:flex;align-items:center;gap:10px;height:36px;padding:0 12px;border-radius:9px;border:0;background:transparent;color:var(--qq-sub);cursor:pointer;text-align:start;font:inherit;transition:background .15s,color .15s}
.qq_nav_item:hover{background:var(--qq-hover);color:var(--qq-text)}
.qq_nav_item.on{background:color-mix(in srgb,var(--qq-accent) 12%,transparent);color:var(--qq-accent);font-weight:600}
.qq_nav_item:focus-visible{outline:2px solid var(--qq-accent);outline-offset:-2px}
.qq_nav_dot{margin-inline-start:auto;width:6px;height:6px;border-radius:50%;background:var(--qq-ok)}
.qq_nav_sep{height:1px;background:var(--qq-line);margin:8px 6px}
.qq_content{flex:1;min-width:0;overflow-y:auto;padding:24px 32px 72px;scrollbar-width:thin}
.qq_page{max-width:880px;margin:0 auto;display:flex;flex-direction:column;gap:16px;animation:qq_in .22s ease-out}
@keyframes qq_in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.qq_page_h{display:flex;flex-direction:column;gap:3px;margin-bottom:2px}
.qq_page_title{font-size:20px;font-weight:650;letter-spacing:.2px}
.qq_page_desc{font-size:13px;color:var(--qq-sub)}

/* ---------- 卡片 ---------- */
.qq_card{background:var(--qq-layer);border:1px solid var(--qq-line);border-radius:14px;padding:18px 20px;display:flex;flex-direction:column;gap:14px}
.qq_card_h{display:flex;align-items:flex-start;gap:12px}
.qq_card_ht{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}
.qq_title{font-size:15px;font-weight:620}
.qq_desc{font-size:12px;color:var(--qq-sub);line-height:1.6}
.qq_sub{display:flex;flex-direction:column;gap:12px;padding:14px 16px;border-radius:12px;border:1px solid var(--qq-line);background:var(--qq-bg);transition:opacity .15s}
.qq_sub.off{opacity:.5}
.qq_sep{font-size:12px;font-weight:600;color:var(--qq-faint);letter-spacing:.8px;text-transform:uppercase;padding-top:4px}

/* ---------- 文字提示 ---------- */
.qq_hint{font-size:12px;color:var(--qq-sub);line-height:1.65}
.qq_note{font-size:12px;line-height:1.65;padding:10px 13px;border-radius:10px;color:var(--qq-text);background:color-mix(in srgb,var(--qq-accent) 8%,transparent);border:1px solid color-mix(in srgb,var(--qq-accent) 22%,transparent)}
.qq_note.warn{background:color-mix(in srgb,var(--qq-warn) 10%,transparent);border-color:color-mix(in srgb,var(--qq-warn) 35%,transparent)}
.qq_more{font-size:12px;color:var(--qq-sub)}
.qq_more>summary{cursor:pointer;list-style:none;display:inline-flex;align-items:center;gap:5px;color:var(--qq-accent);user-select:none}
.qq_more>summary::-webkit-details-marker{display:none}
.qq_more>summary::before{content:"›";display:inline-block;transition:transform .15s;font-size:15px;line-height:1}
.qq_more[open]>summary::before{transform:rotate(90deg)}
.qq_more>div{margin-top:8px;line-height:1.7}

/* ---------- 表单 ---------- */
.qq_grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.qq_grid.three{grid-template-columns:repeat(3,1fr)}
.qq_field{display:flex;flex-direction:column;gap:6px;min-width:0}
.qq_label{font-size:12px;font-weight:550;color:var(--qq-sub)}
.qq_field_hint{font-size:11.5px;color:var(--qq-faint);line-height:1.5}
.qq_input,.qq_textarea,.qq_select{width:100%;height:34px;padding:0 11px;border-radius:9px;border:1px solid var(--qq-line2);background:var(--qq-bg);color:var(--qq-text);font:inherit;transition:border-color .15s,box-shadow .15s}
.qq_textarea{height:auto;min-height:76px;padding:9px 11px;resize:vertical;line-height:1.65}
.qq_select{color-scheme:light dark;padding-inline-end:6px}
.qq_select option{background:Canvas;color:CanvasText}
.qq_input::placeholder,.qq_textarea::placeholder{color:var(--qq-faint)}
.qq_input:hover,.qq_textarea:hover,.qq_select:hover{border-color:var(--qq-faint)}
.qq_input:focus,.qq_textarea:focus,.qq_select:focus{outline:none;border-color:var(--qq-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--qq-accent) 22%,transparent)}
.qq_input:disabled,.qq_textarea:disabled,.qq_select:disabled{opacity:.5;cursor:not-allowed}
.qq_wrap{position:relative;display:flex;align-items:center}
.qq_wrap .qq_input{padding-inline-end:46px}
.qq_unit{position:absolute;inset-inline-end:11px;font-size:12px;color:var(--qq-faint);pointer-events:none}

/* ---------- 开关 ---------- */
.qq_toggle{display:flex;align-items:flex-start;gap:12px;cursor:pointer;padding:2px 0}
.qq_toggle input{appearance:none;-webkit-appearance:none;flex:none;margin:1px 0 0;width:36px;height:20px;border-radius:999px;background:var(--qq-line2);position:relative;cursor:pointer;transition:background .18s;outline:none}
.qq_toggle input::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.35);transition:transform .18s}
.qq_toggle input:checked{background:var(--qq-accent)}
.qq_toggle input:checked::after{transform:translateX(16px)}
.qq_toggle input:focus-visible{box-shadow:0 0 0 3px color-mix(in srgb,var(--qq-accent) 28%,transparent)}
.qq_toggle input:disabled{opacity:.45;cursor:not-allowed}
.qq_toggle_body{display:flex;flex-direction:column;gap:1px;min-width:0}
.qq_toggle_title{font-size:13px;font-weight:550}
.qq_toggle.strong .qq_toggle_title{font-size:14px;font-weight:620}
.qq_toggle_desc{font-size:12px;color:var(--qq-sub);line-height:1.55}

/* ---------- 分段选择 ---------- */
.qq_seg{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:4px;padding:3px;border-radius:11px;background:color-mix(in srgb,var(--qq-text) 6%,transparent)}
.qq_seg_btn{display:flex;flex-direction:column;align-items:center;gap:1px;padding:7px 8px;border:0;border-radius:8px;background:transparent;color:var(--qq-sub);font:inherit;cursor:pointer;transition:background .15s,color .15s,box-shadow .15s}
.qq_seg_btn:hover{color:var(--qq-text)}
.qq_seg_btn.on{background:var(--qq-bg);color:var(--qq-text);font-weight:600;box-shadow:0 1px 4px rgba(0,0,0,.18)}
.qq_seg_sub{font-size:11px;font-weight:400;color:var(--qq-faint)}

/* ---------- 按钮 ---------- */
.qq_btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 14px;border-radius:9px;border:1px solid var(--qq-line2);background:var(--qq-bg);color:var(--qq-text);cursor:pointer;font:inherit;transition:background .15s,border-color .15s,filter .15s,transform .05s}
.qq_btn:hover{background:var(--qq-hover)}
.qq_btn:active{transform:translateY(1px)}
.qq_btn:focus-visible{outline:2px solid var(--qq-accent);outline-offset:2px}
.qq_btn.primary{background:var(--qq-accent);border-color:var(--qq-accent);color:#fff;font-weight:600}
.qq_btn.primary:hover{filter:brightness(1.1);background:var(--qq-accent)}
.qq_btn.danger{color:var(--qq-err);border-color:color-mix(in srgb,var(--qq-err) 45%,transparent)}
.qq_btn.danger:hover{background:color-mix(in srgb,var(--qq-err) 10%,transparent)}
.qq_btn.armed{background:var(--qq-err);border-color:var(--qq-err);color:#fff}
.qq_btn.sm{height:26px;padding:0 10px;font-size:12px;border-radius:8px}
.qq_btn:disabled{opacity:.5;cursor:default;filter:none}
.qq_actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-top:14px;border-top:1px solid var(--qq-line)}
.qq_actions .qq_hint{margin-inline-end:auto}
.qq_actions .qq_btn.primary:first-child:last-child,.qq_actions>.qq_btn.primary:last-child{margin-inline-start:auto}
.qq_row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}

/* ---------- 徽标 / 标签 ---------- */
.qq_badge{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:6px;font-size:11px;color:var(--qq-sub);background:color-mix(in srgb,var(--qq-text) 7%,transparent)}
.qq_badge.ok{color:var(--qq-ok);background:color-mix(in srgb,var(--qq-ok) 12%,transparent)}
.qq_badge.warn{color:var(--qq-warn);background:color-mix(in srgb,var(--qq-warn) 12%,transparent)}
.qq_chips{display:flex;flex-wrap:wrap;gap:6px}

/* ---------- 概览 ---------- */
.qq_hero{display:flex;align-items:center;gap:16px;padding:20px 22px;border-radius:16px;border:1px solid var(--qq-line);background:linear-gradient(135deg,color-mix(in srgb,var(--qq-accent) 13%,transparent),color-mix(in srgb,var(--qq-accent) 3%,transparent))}
.qq_hero.bad{background:linear-gradient(135deg,color-mix(in srgb,var(--qq-warn) 14%,transparent),color-mix(in srgb,var(--qq-warn) 3%,transparent))}
.qq_hero_ic{flex:none;width:46px;height:46px;border-radius:14px;display:grid;place-items:center;background:var(--qq-bg);color:var(--qq-ok);box-shadow:0 2px 10px rgba(0,0,0,.12)}
.qq_hero.bad .qq_hero_ic{color:var(--qq-warn)}
.qq_hero_t{font-size:16px;font-weight:650}
.qq_hero_s{font-size:12.5px;color:var(--qq-sub);margin-top:2px}
.qq_copy{display:flex;gap:8px;align-items:stretch}
.qq_copy .qq_input{flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;letter-spacing:.01em}
.qq_copy .qq_btn{flex:none;white-space:nowrap}
.qq_stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.qq_stat{display:flex;flex-direction:column;gap:6px;padding:14px 16px;border-radius:13px;border:1px solid var(--qq-line);background:var(--qq-layer);text-align:start;font:inherit;color:inherit;cursor:pointer;transition:border-color .15s,transform .15s,background .15s}
.qq_stat:hover{border-color:color-mix(in srgb,var(--qq-accent) 55%,transparent);background:color-mix(in srgb,var(--qq-accent) 5%,var(--qq-layer));transform:translateY(-1px)}
.qq_stat_l{font-size:12px;color:var(--qq-sub);display:flex;align-items:center;gap:6px}
.qq_stat_v{font-size:22px;font-weight:650;line-height:1.15;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qq_stat_v.sm{font-size:16px;padding:3px 0}
.qq_stat_s{font-size:11.5px;color:var(--qq-faint)}

/* ---------- 列表 + 详情 ---------- */
.qq_split{display:flex;gap:14px;align-items:flex-start}
.qq_listcol{flex:0 0 290px;min-width:0;display:flex;flex-direction:column;gap:8px}
.qq_list{display:flex;flex-direction:column;gap:6px;max-height:440px;overflow:auto;padding-inline-end:2px;scrollbar-width:thin}
.qq_item{display:flex;gap:11px;align-items:center;padding:9px 11px;border-radius:11px;border:1px solid var(--qq-line);background:var(--qq-bg);cursor:pointer;transition:border-color .15s,background .15s}
.qq_item:hover{background:var(--qq-hover)}
.qq_item.sel{border-color:var(--qq-accent);background:color-mix(in srgb,var(--qq-accent) 8%,var(--qq-bg))}
.qq_item_main{min-width:0;flex:1}
.qq_item_name{font-size:13px;font-weight:580;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qq_item_meta{font-size:11px;color:var(--qq-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qq_avatar{flex:none;width:34px;height:34px;border-radius:50%;display:grid;place-items:center;font-weight:650;font-size:14px;color:#fff}
.qq_avatar.sq{border-radius:10px}
.qq_detail{flex:1;min-width:0;display:flex;flex-direction:column;gap:14px;padding:16px;border-radius:12px;border:1px solid var(--qq-line);background:var(--qq-bg)}
.qq_detail_h{display:flex;align-items:center;gap:11px}
.qq_empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:28px 16px;text-align:center;color:var(--qq-faint);font-size:12.5px;border:1px dashed var(--qq-line2);border-radius:12px;flex:1}
.qq_empty_ic{opacity:.55}

/* ---------- 表情包 ---------- */
.qq_stickers{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:12px}
.qq_sticker{position:relative;display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:12px;border:1px solid var(--qq-line);background:var(--qq-bg);transition:border-color .15s}
.qq_sticker:hover{border-color:var(--qq-line2)}
.qq_sticker img{width:100%;aspect-ratio:1;object-fit:contain;border-radius:8px}
.qq_sticker_tag{font-size:11px;color:var(--qq-sub);text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qq_sticker_del{position:absolute;top:5px;inset-inline-end:5px;width:22px;height:22px;border-radius:50%;border:0;display:grid;place-items:center;background:rgba(0,0,0,.55);color:#fff;cursor:pointer;opacity:0;transition:opacity .15s;font-size:13px;line-height:1}
.qq_sticker:hover .qq_sticker_del,.qq_sticker_del:focus-visible{opacity:1}
.qq_sticker_del:hover{background:var(--qq-err)}

/* ---------- 提示条 / 加载 ---------- */
.qq_toast{position:absolute;z-index:20;top:70px;left:50%;transform:translateX(-50%);max-width:min(560px,calc(100% - 32px));pointer-events:none;animation:qq_toast .22s ease-out}
@keyframes qq_toast{from{opacity:0;transform:translate(-50%,-8px)}to{opacity:1;transform:translate(-50%,0)}}
.qq_msg{display:flex;align-items:flex-start;gap:9px;padding:10px 15px;border-radius:12px;font-size:12.5px;line-height:1.55;background:var(--qq-bg);border:1px solid var(--qq-line2);box-shadow:0 8px 28px rgba(0,0,0,.22);pointer-events:auto}
.qq_msg.ok{border-color:color-mix(in srgb,var(--qq-ok) 50%,transparent)}
.qq_msg.ok::before{content:"✓";color:var(--qq-ok);font-weight:700}
.qq_msg.err{border-color:color-mix(in srgb,var(--qq-err) 55%,transparent)}
.qq_msg.err::before{content:"!";color:var(--qq-err);font-weight:700}
.qq_skel{height:96px;border-radius:14px;background:linear-gradient(90deg,var(--qq-layer),color-mix(in srgb,var(--qq-text) 9%,var(--qq-layer)),var(--qq-layer));background-size:220% 100%;animation:qq_shim 1.3s infinite linear}
@keyframes qq_shim{from{background-position:120% 0}to{background-position:-120% 0}}
.qq_center{margin:auto;max-width:420px;display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center;padding:40px 20px}

/* ---------- 窄面板（侧边栏展开 / 小窗口） ---------- */
@container (max-width:760px){
.qq_body{flex-direction:column}
.qq_nav{width:auto;flex-direction:row;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;border-inline-end:0;border-bottom:1px solid var(--qq-line);padding:8px 12px;gap:4px}.qq_nav::-webkit-scrollbar{display:none}.qq_stats{grid-template-columns:repeat(2,1fr)}
.qq_nav_item{flex:none;white-space:nowrap}
.qq_nav_sep{display:none}
.qq_content{padding:18px 16px 56px}
.qq_head{padding-inline:16px}
.qq_grid,.qq_grid.three{grid-template-columns:1fr}
.qq_split{flex-direction:column}
.qq_listcol{flex:none;width:100%}
.qq_detail{width:100%}
}
@media (prefers-reduced-motion:reduce){.qq_app *{animation:none!important;transition:none!important}}
`;

		function useCss() {
			react.useEffect(() => {
				const id = 'dsh-qq-style';
				// 重新加载模块时刷新样式，避免旧版本残留
				const old = document.getElementById(id);
				if (old) {
					old.textContent = css;
					return;
				}
				const el = document.createElement('style');
				el.id = id;
				el.textContent = css;
				document.head.appendChild(el);
			}, []);
		}

		// ---------- 图标（24x24 描边，颜色跟随文字） ----------
		const ICONS = {
			home: ['M4 11.5 12 4l8 7.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z'],
			user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8'],
			shield: ['M12 3 4.5 6v6c0 4.4 3.1 8 7.5 9 4.4-1 7.5-4.6 7.5-9V6z', 'm8.8 12 2.4 2.4 4-4.4'],
			bolt: ['M13 2 4 14h7l-1 8 9-12h-7z'],
			chat: ['M20.5 15.5a2 2 0 0 1-2 2H8.5l-4 3.5V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z', 'M8.5 10.5h.01M12.5 10.5h.01M16.5 10.5h.01'],
			layers: ['m12 3 9 5-9 5-9-5z', 'm3 12.5 9 5 9-5', 'm3 16.5 9 5 9-5'],
			smile: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M8.2 14.2c.9 1.4 2.2 2.1 3.8 2.1s2.9-.7 3.8-2.1', 'M9 9.6h.01M15 9.6h.01'],
			cpu: ['M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z', 'M9.5 9.5h5v5h-5z', 'M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3'],
			check: ['M20 6 9 17l-5-5'],
			plug: ['M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0z', 'M12 17v4'],
			copy: ['M9 3h6a1 1 0 0 1 1 1v2H8V4a1 1 0 0 1 1-1z', 'M8 6h8v2H8z', 'M7 8H5.5A1.5 1.5 0 0 0 4 9.5v11A1.5 1.5 0 0 0 5.5 22h9A1.5 1.5 0 0 0 16 20.5V18', 'M8.5 8h10A1.5 1.5 0 0 1 20 9.5v11a1.5 1.5 0 0 1-1.5 1.5H8.5A1.5 1.5 0 0 1 7 20.5v-11A1.5 1.5 0 0 1 8.5 8z'],
			search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'm20 20-3.8-3.8'],
			users: ['M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6', 'M16.5 4.4a3.5 3.5 0 0 1 0 6.7M18 14.3c2 .7 3.5 2.6 3.5 5.7'],
		};
		function Icon(props) {
			const size = props.size ?? 16;
			return h(
				'svg',
				{
					width: size,
					height: size,
					viewBox: '0 0 24 24',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: props.stroke ?? 1.8,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': true,
					style: { flex: 'none' },
				},
				(ICONS[props.name] ?? []).map((d, i) => h('path', { key: i, d })),
			);
		}

		/** 侧边栏入口行里的图标（宿主传入 size / active） */
		function QqIcon(props) {
			const size = props && typeof props.size === 'number' ? props.size : 16;
			return h(Icon, { name: 'chat', size, stroke: props?.active ? 2.2 : 1.8 });
		}

		// ---------- 基础组件 ----------
		function Card(props) {
			return h(
				'div',
				{ className: 'qq_card' },
				h(
					'div',
					{ className: 'qq_card_h' },
					h('div', { className: 'qq_card_ht' }, h('div', { className: 'qq_title' }, props.title), props.desc ? h('div', { className: 'qq_desc' }, props.desc) : null),
					props.aside ?? null,
				),
				props.children,
			);
		}

		function Field(props) {
			const body = props.unit ? h('div', { className: 'qq_wrap' }, props.children, h('span', { className: 'qq_unit' }, props.unit)) : props.children;
			return h(
				'div',
				{ className: 'qq_field', style: props.wide ? { gridColumn: '1 / -1' } : undefined },
				h('label', { className: 'qq_label' }, props.label),
				body,
				props.hint ? h('div', { className: 'qq_field_hint' }, props.hint) : null,
			);
		}

		function Toggle(props) {
			return h(
				'label',
				{ className: 'qq_toggle' + (props.strong ? ' strong' : '') },
				h('input', { type: 'checkbox', checked: Boolean(props.checked), disabled: props.disabled, onChange: props.onChange }),
				h(
					'span',
					{ className: 'qq_toggle_body' },
					h('span', { className: 'qq_toggle_title' }, props.label),
					props.desc ? h('span', { className: 'qq_toggle_desc' }, props.desc) : null,
				),
			);
		}

		function Seg(props) {
			return h(
				'div',
				{ className: 'qq_seg', role: 'radiogroup' },
				props.options.map((o) =>
					h(
						'button',
						{
							key: o.value,
							type: 'button',
							role: 'radio',
							'aria-checked': props.value === o.value,
							className: 'qq_seg_btn' + (props.value === o.value ? ' on' : ''),
							onClick: () => props.onChange(o.value),
						},
						h('span', null, o.label),
						o.sub ? h('span', { className: 'qq_seg_sub' }, o.sub) : null,
					),
				),
			);
		}

		/** 折叠的长说明：默认收起，不抢正文 */
		function More(props) {
			return h('details', { className: 'qq_more' }, h('summary', null, props.title ?? '了解更多'), h('div', null, props.children));
		}

		function Empty(props) {
			return h('div', { className: 'qq_empty' }, h('div', { className: 'qq_empty_ic' }, h(Icon, { name: props.icon ?? 'layers', size: 26 })), h('div', null, props.children));
		}

		function Avatar(props) {
			const seed = String(props.seed ?? props.text ?? '');
			let hue = 0;
			for (let i = 0; i < seed.length; i++) hue = (hue * 31 + seed.charCodeAt(i)) % 360;
			const ch = String(props.text ?? '?').trim().slice(0, 1) || '?';
			return h('div', { className: 'qq_avatar' + (props.square ? ' sq' : ''), style: { background: `hsl(${hue} 52% 48%)` } }, ch);
		}

		function Page(props) {
			return h(
				'div',
				{ className: 'qq_page', key: props.id },
				h('div', { className: 'qq_page_h' }, h('div', { className: 'qq_page_title' }, props.title), props.desc ? h('div', { className: 'qq_page_desc' }, props.desc) : null),
				props.children,
			);
		}

		async function post(url, body) {
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			});
			return res.json();
		}

		const TABS = [
			{ id: 'overview', label: '概览', icon: 'home' },
			{ id: 'persona', label: '角色', icon: 'user' },
			{ id: 'access', label: '对话规则', icon: 'shield' },
			{ id: 'proactive', label: '主动发言', icon: 'bolt' },
			{ id: 'human', label: '拟人化', icon: 'chat' },
			{ id: 'memory', label: '记忆', icon: 'layers' },
			{ id: 'stickers', label: '表情包', icon: 'smile' },
			{ id: 'model', label: '模型与邮件', icon: 'cpu' },
		];

		function QqPanel() {
			useCss();
			const [tab, setTabState] = react.useState(() => {
				try {
					const saved = window.localStorage?.getItem('dsh-qq-tab');
					return TABS.some((x) => x.id === saved) ? saved : 'overview';
				} catch {
					return 'overview';
				}
			});
			const setTab = (id) => {
				setTabState(id);
				try {
					window.localStorage?.setItem('dsh-qq-tab', id);
				} catch {}
			};
			const contentRef = react.useRef(null);
			react.useEffect(() => {
				contentRef.current?.scrollTo?.({ top: 0 });
			}, [tab]);
			const [memQuery, setMemQuery] = react.useState('');
			const [reloadTick, setReloadTick] = react.useState(0);
			const [state, setState] = react.useState(null);
			const [loadError, setLoadError] = react.useState(null);
			const [msg, setMsg] = react.useState(null);
			const [busy, setBusy] = react.useState(false);

			const [personas, setPersonas] = react.useState([]);
			const [personaFile, setPersonaFile] = react.useState('');
			const [persona, setPersona] = react.useState(null);

			const [groups, setGroups] = react.useState('');
			const [users, setUsers] = react.useState('');
			const [trigger, setTrigger] = react.useState('at');
			const [keywords, setKeywords] = react.useState('在吗，你怎么看，帮我看，求助，你怎么想');
			const DEFAULT_KEYWORDS = '在吗，你怎么看，帮我看，求助，你怎么想，有没有人，谁能帮';
			const [memberScope, setMemberScope] = react.useState('whitelist');
			const [cooldown, setCooldown] = react.useState(5);
			const [perGroup, setPerGroup] = react.useState(60);
			const [followSec, setFollowSec] = react.useState(90);
			const [followMax, setFollowMax] = react.useState(3);
			const [pokeStale, setPokeStale] = react.useState(90);

			const [proactive, setProactive] = react.useState({
				enabled: false,
				idleEnabled: true,
				idleMinutes: 90,
				maxPerHour: 2,
				ambientEnabled: false,
				sampleRate: 0.03,
				privateEnabled: false,
				privateIdleHours: 24,
				privateMaxPerDay: 1,
				quietHours: '23:30-08:00',
				pauseSeconds: 90,
				pauseEnabled: true,
				pauseSampleRate: 0.15,
			});

			const [modelCfg, setModelCfg] = react.useState({ provider: '', model: '', reasoningEffort: '' });
			const [mailCfg, setMailCfg] = react.useState({ enabled: false, watchMinutes: 30 });
			const [modelInfo, setModelInfo] = react.useState(null);
			const [ambientStats, setAmbientStats] = react.useState({});
			const [lastChime, setLastChime] = react.useState(null);
			const [memory, setMemory] = react.useState({ profiles: [], groups: [] });
			const [stickers, setStickers] = react.useState({ count: 0, items: [], autoSave: 'stickers', visionMode: 'onDemand' });
			const [human, setHuman] = react.useState({
				enabled: true,
				splitProbability: 0.55,
				maxBubbles: 3,
				perCharMs: 55,
				minTypingMs: 700,
				maxTypingMs: 6500,
				debounceMs: 1800,
				minSplitChars: 24,
				stripPeriod: true,
				timeAware: true,
			});
			const [social, setSocial] = react.useState({
				repeatEnabled: true,
				repeatProb: 0.5,
				repeatMinUsers: 3,
				reactEnabled: true,
				reactProb: 0.12,
				pokeEnabled: true,
				pokeProb: 0.4,
			});
			const [gmem, setGmem] = react.useState({
				settings: { enabled: true, everyMessages: 40, minIntervalMinutes: 30, maxPerDay: 12 },
				groups: [],
			});
			const [gmemSel, setGmemSel] = react.useState(null);
			const [selected, setSelected] = react.useState(null);
			// 不用原生弹窗：Electron 里 window.prompt 直接抛错，confirm 也不统一
			const [creating, setCreating] = react.useState(false);
			const [newName, setNewName] = react.useState('新角色');
			const [confirmKey, setConfirmKey] = react.useState(null);
			const confirmTimer = react.useRef(null);
			const armConfirm = (key) => {
				setConfirmKey(key);
				if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
				confirmTimer.current = window.setTimeout(() => setConfirmKey(null), 5000);
			};

			// 提示条只保留最后一条：连续操作时，旧定时器不能把新提示提前抹掉
			const flashTimer = react.useRef(null);
			const flash = (kind, text) => {
				setMsg({ kind, text });
				if (flashTimer.current) window.clearTimeout(flashTimer.current);
				flashTimer.current = window.setTimeout(() => setMsg(null), kind === 'err' ? 6000 : 4000);
			};

			const reloadPersonas = () =>
				fetch('/dsh-qq/api/personas')
					.then((r) => r.json())
					.then((d) => {
						if (d.ok) setPersonas(d.personas ?? []);
					})
					.catch(() => {});

			const reloadStickers = () =>
				fetch('/dsh-qq/api/stickers')
					.then((r) => r.json())
					.then((d) => {
						if (d.ok)
							setStickers({
								count: d.count ?? 0,
								items: d.items ?? [],
								autoSave: d.autoSave ?? 'stickers',
								visionMode: d.visionMode ?? 'onDemand',
							});
					})
					.catch(() => {});

			const reloadMemory = () =>
				fetch('/dsh-qq/api/memory')
					.then((r) => r.json())
					.then((d) => {
						if (d.ok) setMemory({ profiles: d.profiles ?? [], groups: d.groups ?? [] });
					})
					.catch(() => {});

			const reloadGmem = () =>
				fetch('/dsh-qq/api/groupmem')
					.then((r) => r.json())
					.then((d) => {
						if (d.ok) setGmem((g) => ({ settings: d.settings ?? g.settings, groups: d.groups ?? [] }));
					})
					.catch(() => {});

			react.useEffect(() => {
				let alive = true;
				fetch('/dsh-qq/api/state')
					.then((r) => {
						if (!r.ok) throw new Error('HTTP ' + r.status);
						return r.json();
					})
					.then((data) => {
						if (!alive || !data.ok) return;
						setState(data);
						setGroups((data.config.access.groups ?? []).join(', '));
						setUsers((data.config.access.users ?? []).join(', '));
						setTrigger(data.config.access.groupTrigger ?? 'at');
						const kws = data.config.access.keywords;
						if (Array.isArray(kws) && kws.length) setKeywords(kws.join('，'));
						setMemberScope(data.config.access.groupMemberScope ?? 'whitelist');
						setCooldown(data.config.limits?.perUserCooldownSec ?? 5);
						const hm = data.config.humanize ?? {};
						setHuman({
							enabled: hm.enabled !== false,
							splitProbability: hm.splitProbability ?? 0.55,
							maxBubbles: hm.maxBubbles ?? 3,
							perCharMs: hm.perCharMs ?? 55,
							minTypingMs: hm.minTypingMs ?? 700,
							maxTypingMs: hm.maxTypingMs ?? 6500,
							debounceMs: hm.debounceMs ?? 1800,
							minSplitChars: hm.minSplitChars ?? 24,
							stripPeriod: hm.stripPeriod !== false,
							timeAware: hm.timeAware !== false,
						});
						setFollowSec(data.config.access.followUpSeconds ?? 90);
						setFollowMax(data.config.access.followUpMax ?? 3);
						setPokeStale(data.config.access.pokeStaleSeconds ?? 90);
						// 配置文件里没写的项，用后端告知的"实际生效值"当默认，避免页面和真实行为不一致
						const es = data.effective?.social;
						if (es) {
							setSocial({
								repeatEnabled: es.repeat.enabled,
								repeatProb: es.repeat.probability,
								repeatMinUsers: es.repeat.minUsers,
								reactEnabled: es.react.enabled,
								reactProb: es.react.probability,
								pokeEnabled: es.pokeBack.enabled,
								pokeProb: es.pokeBack.probability,
							});
						}
						if (data.effective?.groupMemory) setGmem((g) => ({ ...g, settings: data.effective.groupMemory }));
						setPerGroup(data.config.limits?.perGroupPerHour ?? 60);
						setPersonaFile(data.persona?.file ?? '');
						const p = data.config.proactive ?? {};
						setProactive({
							enabled: Boolean(p.enabled),
							idleEnabled: p.idle?.enabled !== false,
							idleMinutes: p.idle?.minutes ?? p.idleMinutes ?? 90,
							maxPerHour: p.maxPerHour ?? 2,
							ambientEnabled: Boolean(p.ambient?.enabled),
							sampleRate: p.ambient?.sampleRate ?? 0.03,
							privateEnabled: Boolean(p.private?.enabled),
							privateIdleHours: p.private?.idleHours ?? 24,
							privateMaxPerDay: p.private?.maxPerDay ?? 1,
							quietHours: (p.quietHours ?? []).join(', '),
							pauseSeconds: p.pause?.seconds ?? 90,
							pauseEnabled: p.pause?.enabled !== false,
							pauseSampleRate:
								p.pause?.sampleRate ?? data.effective?.proactive?.pause?.sampleRate ?? p.ambient?.sampleRate ?? 0.15,
						});
						const mc2 = data.mail ?? {};
						setMailCfg({ enabled: mc2.enabled === true, watchMinutes: mc2.watchMinutes ?? 30 });
						setModelInfo(data.model ?? null);
						const mc = data.model?.configured ?? {};
						setModelCfg({
							provider: mc.provider ?? '',
							model: mc.model ?? '',
							reasoningEffort: mc.reasoningEffort ?? '',
						});
						setAmbientStats(data.ambientStats ?? {});
						setLastChime(data.lastChimeAt ?? null);
					})
					.catch((err) => {
						if (alive) setLoadError(String(err.message ?? err));
					});
				reloadPersonas();
				reloadMemory();
				reloadStickers();
				reloadGmem();
				return () => {
					alive = false;
				};
			}, [reloadTick]);

			react.useEffect(() => {
				if (!personaFile) return;
				fetch('/dsh-qq/api/persona?file=' + encodeURIComponent(personaFile))
					.then((r) => r.json())
					.then((d) => {
						if (d.ok) setPersona(d.data);
					})
					.catch(() => {});
			}, [personaFile]);

			const setStickerMode = async (mode) => {
				try {
					const d = await post('/dsh-qq/api/stickers/save', { autoSave: mode });
					if (d.ok) {
						setStickers((s) => ({ ...s, autoSave: mode }));
						flash('ok', '保存策略已更新');
					} else flash('err', d.error ?? '保存失败');
				} catch (e) {
					flash('err', String(e));
				}
			};

			const setVisionMode = async (mode) => {
				try {
					const d = await post('/dsh-qq/api/stickers/save', { visionMode: mode });
					if (d.ok) {
						setStickers((s) => ({ ...s, visionMode: mode }));
						flash('ok', '看图模式已更新');
					} else flash('err', d.error ?? '保存失败');
				} catch (e) {
					flash('err', String(e));
				}
			};

			const removeSticker = async (hash) => {
				try {
					const d = await post('/dsh-qq/api/stickers/save', { remove: hash });
					if (d.ok) {
						flash('ok', '已删除这张');
						reloadStickers();
					} else flash('err', d.error ?? '删除失败');
				} catch (e) {
					flash('err', String(e));
				}
			};

			const saveMail = async () => {
				setBusy(true);
				try {
					const d = await post('/dsh-qq/api/config', {
						mail: { enabled: mailCfg.enabled, watchMinutes: Number(mailCfg.watchMinutes) || 30 },
					});
					d.ok ? flash('ok', '邮件助理设置已保存') : flash('err', d.error ?? '保存失败');
				} catch (e) {
					flash('err', String(e));
				} finally {
					setBusy(false);
				}
			};

			const saveModel = async (reset) => {
				setBusy(true);
				try {
					const d = reset
						? await post('/dsh-qq/api/model/save', { reset: true })
						: await post('/dsh-qq/api/model/save', modelCfg);
					if (!d.ok) {
						flash('err', d.error ?? '保存失败');
						return;
					}
					if (reset) {
						flash('ok', `已解绑 ${d.reset ?? 0} 个会话，下条消息会按新配置重建`);
					} else {
						setModelInfo(d.model ?? modelInfo);
						flash('ok', '模型配置已保存（点下方"重建会话"立即生效）');
					}
				} catch (e) {
					flash('err', String(e));
				} finally {
					setBusy(false);
				}
			};

			const saveHuman = async () => {
				setBusy(true);
				try {
					const d = await post('/dsh-qq/api/config', {
						humanize: {
							enabled: human.enabled,
							splitProbability: Number(human.splitProbability),
							maxBubbles: Number(human.maxBubbles) || 3,
							perCharMs: Number(human.perCharMs) || 55,
							minTypingMs: Number(human.minTypingMs) || 700,
							maxTypingMs: Number(human.maxTypingMs) || 6500,
							debounceMs: numOr(human.debounceMs, 1800),
							minSplitChars: numOr(human.minSplitChars, 24),
							stripPeriod: human.stripPeriod,
							timeAware: human.timeAware,
						},
					});
					reportSaved(d, '说话方式已保存');
				} catch (e) {
					flash('err', String(e));
				} finally {
					setBusy(false);
				}
			};

			const saveAccess = async () => {
				setBusy(true);
				try {
					const d = await post('/dsh-qq/api/config', {
						access: {
							groups: groups.split(/[,，\s]+/).filter(Boolean),
							users: users.split(/[,，\s]+/).filter(Boolean),
							groupTrigger: trigger,
							keywords: String(keywords)
								.split(/[,，、\n]+/)
								.map((s) => s.trim())
								.filter(Boolean),
							groupMemberScope: memberScope,
							followUpSeconds: numOr(followSec, 90),
							followUpMax: numOr(followMax, 3),
							pokeStaleSeconds: numOr(pokeStale, 90),
						},
						limits: {
							perUserCooldownSec: Number(cooldown) || 0,
							perGroupPerHour: Number(perGroup) || 60,
						},
					});
					reportSaved(d, '白名单已保存');
				} catch (e) {
					flash('err', String(e));
				} finally {
					setBusy(false);
				}
			};

			const saveProactive = async () => {
				setBusy(true);
				try {
					const d = await post('/dsh-qq/api/config', {
						proactive: {
							enabled: proactive.enabled,
							maxPerHour: Number(proactive.maxPerHour) || 2,
							quietHours: proactive.quietHours.split(/[,，\s]+/).filter(Boolean),
							idle: {
								enabled: proactive.idleEnabled,
								minutes: Number(proactive.idleMinutes) || 90,
							},
							pause: {
								// 以前这里写死 enabled:true，页面上关不掉停顿接话
								enabled: proactive.pauseEnabled,
								seconds: Number(proactive.pauseSeconds) || 90,
								sampleRate: numOr(proactive.pauseSampleRate, 0.15),
							},
							ambient: {
								enabled: proactive.ambientEnabled,
								sampleRate: Number(proactive.sampleRate) || 0.03,
							},
							private: {
								enabled: proactive.privateEnabled,
								idleHours: Number(proactive.privateIdleHours) || 24,
								maxPerDay: Number(proactive.privateMaxPerDay) || 1,
							},
						},
					});
					reportSaved(d, '主动发言设置已保存');
				} catch (e) {
					flash('err', String(e));
				} finally {
					setBusy(false);
				}
			};

			// 表单里空串/非数字时用默认值；注意 0 是合法值（不能写成 Number(x) || 默认）
			const numOr = (v, fallback) => {
				if (v === '' || v === null || v === undefined) return fallback;
				const n = Number(v);
				return Number.isFinite(n) ? n : fallback;
			};

			// 后端会把越界值夹回合法范围，并在 clamped 里告知；页面要如实提示，不能假装存的就是填的
			const reportSaved = (d, okText) => {
				if (!d.ok) return flash('err', d.error ?? '保存失败');
				if (d.clamped?.length) {
					const detail = d.clamped.map((c) => `${c.path} → ${c.to}`).join('、');
					return flash('ok', `${okText}（有值超出范围，已自动调整：${detail}）`);
				}
				flash('ok', okText);
			};

			const saveSocial = async () => {
				setBusy(true);
				try {
					const d = await post('/dsh-qq/api/config', {
						social: {
							repeat: { enabled: social.repeatEnabled, probability: numOr(social.repeatProb, 0.5), minUsers: numOr(social.repeatMinUsers, 3) },
							react: { enabled: social.reactEnabled, probability: numOr(social.reactProb, 0.12) },
							pokeBack: { enabled: social.pokeEnabled, probability: numOr(social.pokeProb, 0.4) },
						},
					});
					reportSaved(d, '社交动作设置已保存');
				} catch (e) {
					flash('err', String(e));
				} finally {
					setBusy(false);
				}
			};

			const saveGmemSettings = async () => {
				setBusy(true);
				try {
					const s = gmem.settings;
					const d = await post('/dsh-qq/api/config', {
						groupMemory: {
							enabled: s.enabled,
							everyMessages: numOr(s.everyMessages, 40),
							minIntervalMinutes: numOr(s.minIntervalMinutes, 30),
							maxPerDay: numOr(s.maxPerDay, 12),
						},
					});
					reportSaved(d, '群记忆设置已保存');
				} catch (e) {
					flash('err', String(e));
				} finally {
					setBusy(false);
				}
			};

			const openGmem = (g) =>
				setGmemSel({
					chatKey: g.chatKey,
					lore: g.notes?.lore ?? [],
					relations: g.notes?.relations ?? [],
					topics: g.notes?.topics ?? [],
				});

			const saveGmemNotes = async () => {
				if (!gmemSel) return;
				try {
					const d = await post('/dsh-qq/api/groupmem/save', {
						chatKey: gmemSel.chatKey,
						notes: { lore: gmemSel.lore, relations: gmemSel.relations, topics: gmemSel.topics },
					});
					if (d.ok) {
						// 后端会清洗（去换行、去标记、截断），用它返回的结果回填，让页面看到真实存下的内容
						setGmemSel({ chatKey: gmemSel.chatKey, ...d.notes });
						flash('ok', '群记忆已保存（立刻生效）');
						reloadGmem();
					} else flash('err', d.error ?? '保存失败');
				} catch (e) {
					flash('err', String(e));
				}
			};

			const summarizeGmem = async () => {
				if (!gmemSel) return;
				try {
					const d = await post('/dsh-qq/api/groupmem/save', { chatKey: gmemSel.chatKey, summarizeNow: true });
					if (d.ok) {
						flash('ok', '已开始总结（需要调用一次模型，稍后点"刷新"查看）');
					} else flash('err', d.error ?? '触发失败');
				} catch (e) {
					flash('err', String(e));
				}
			};

			const removeGmem = async () => {
				if (!gmemSel) return;
				if (confirmKey !== 'gmem') {
					armConfirm('gmem');
					flash('err', '再点一次「确认清空」才会删除这个群的记忆');
					return;
				}
				setConfirmKey(null);
				try {
					const d = await post('/dsh-qq/api/groupmem/save', { chatKey: gmemSel.chatKey, remove: true });
					if (d.ok) {
						setGmemSel(null);
						reloadGmem();
						flash('ok', '已清空（下次积累够了会从头总结）');
					} else flash('err', d.error ?? '清空失败');
				} catch (e) {
					flash('err', String(e));
				}
			};

			const savePersona = async () => {
				setBusy(true);
				try {
					const d = await post('/dsh-qq/api/persona/save', { file: personaFile, data: persona });
					d.ok ? flash('ok', '角色卡已保存') : flash('err', d.error ?? '保存失败');
				} catch (e) {
					flash('err', String(e));
				} finally {
					setBusy(false);
				}
			};

			const switchPersona = async (file) => {
				setPersonaFile(file);
				try {
					const d = await post('/dsh-qq/api/persona/save', { switchTo: file });
					d.ok ? flash('ok', '已切换（新会话生效）') : flash('err', d.error ?? '切换失败');
				} catch (e) {
					flash('err', String(e));
				}
			};

			const createPersona = async (rawName) => {
				const name = String(rawName ?? '').trim();
				if (!name) return flash('err', '名字不能为空');
				const slug = 'persona/custom-' + Date.now().toString(36) + '.json';
				try {
					const d = await post('/dsh-qq/api/persona/save', { create: { file: slug, from: personaFile, name } });
					if (!d.ok) return flash('err', d.error ?? '创建失败');
					await reloadPersonas();
					setPersonaFile(slug);
					setCreating(false);
					flash('ok', '已从当前角色卡复制一份');
				} catch (e) {
					flash('err', String(e));
				}
			};

			const deletePersona = async () => {
				if (!personaFile) return;
				if (confirmKey !== 'persona') {
					armConfirm('persona');
					flash('err', '再点一次「确认删除」才会删掉');
					return;
				}
				setConfirmKey(null);
				try {
					const d = await post('/dsh-qq/api/persona/save', { remove: personaFile });
					if (!d.ok) return flash('err', d.error ?? '删除失败');
					await reloadPersonas();
					flash('ok', '已删除');
				} catch (e) {
					flash('err', String(e));
				}
			};

			const openProfile = async (userId) => {
				try {
					const r = await fetch('/dsh-qq/api/memory/profile?userId=' + encodeURIComponent(userId));
					const d = await r.json();
					if (d.ok) setSelected(d.profile);
					else flash('err', d.error ?? '读取失败');
				} catch (e) {
					flash('err', String(e));
				}
			};

			const saveProfile = async () => {
				if (!selected) return;
				try {
					const d = await post('/dsh-qq/api/memory/save', { profile: selected });
					if (d.ok) {
						flash('ok', '画像已保存');
						reloadMemory();
					} else flash('err', d.error ?? '保存失败');
				} catch (e) {
					flash('err', String(e));
				}
			};

			const deleteProfile = async () => {
				if (!selected) return;
				if (confirmKey !== 'profile') {
					armConfirm('profile');
					flash('err', '再点一次「确认忘掉」才会删除画像');
					return;
				}
				setConfirmKey(null);
				try {
					const d = await post('/dsh-qq/api/memory/save', { remove: selected.userId });
					if (d.ok) {
						setSelected(null);
						reloadMemory();
						flash('ok', '已删除');
					} else flash('err', d.error ?? '删除失败');
				} catch (e) {
					flash('err', String(e));
				}
			};

			const setP = (patch) => setPersona((p) => ({ ...(p ?? {}), ...patch }));
			const setSpeech = (patch) => setP({ speech: { ...(persona?.speech ?? {}), ...patch } });
			const lines = (arr) => (Array.isArray(arr) ? arr.join('\n') : '');
			const split = (text) =>
				String(text ?? '')
					.split('\n')
					.map((s) => s.trim())
					.filter(Boolean);


			// ================= 渲染 =================
			const toast = msg ? h('div', { className: 'qq_toast', role: 'status' }, h('div', { className: 'qq_msg ' + msg.kind }, msg.text)) : null;

			const header = (sub, status) =>
				h(
					'div',
					{ className: 'qq_head' },
					h('div', { className: 'qq_logo' }, h(Icon, { name: 'chat', size: 20, stroke: 2 })),
					h('div', { className: 'qq_head_t' }, h('div', { className: 'qq_head_title' }, 'QQ 机器人'), h('div', { className: 'qq_head_sub' }, sub)),
					h('div', { className: 'qq_head_r' }, status),
				);

			if (loadError) {
				return h(
					'div',
					{ className: 'qq_app' },
					toast,
					header('设置接口不可用', null),
					h(
						'div',
						{ className: 'qq_content' },
						h(
							'div',
							{ className: 'qq_center' },
							h('div', { className: 'qq_empty_ic' }, h(Icon, { name: 'plug', size: 34 })),
							h('div', { className: 'qq_title' }, '设置接口不可用'),
							h('div', { className: 'qq_hint' }, `请求 /dsh-qq/api/state 失败：${loadError}`),
							h('div', { className: 'qq_hint' }, '看插件日志 data/plugin.log 里的「设置接口」几行。装完插件后需要重启应用才会生效。'),
							h(
								'button',
								{
									className: 'qq_btn primary',
									onClick: () => {
										setLoadError(null);
										setReloadTick((n) => n + 1);
									},
								},
								'重试',
							),
						),
					),
				);
			}
			if (!state) {
				return h(
					'div',
					{ className: 'qq_app' },
					header('正在读取配置…', null),
					h('div', { className: 'qq_content' }, h('div', { className: 'qq_page' }, h('div', { className: 'qq_skel', style: { height: 84 } }), h('div', { className: 'qq_skel' }), h('div', { className: 'qq_skel', style: { height: 160 } }))),
				);
			}

			const online = Boolean(state.stats?.online);
			const wsUrl = state.onebot?.url || 'ws://127.0.0.1:7800/onebot';
			const copyListenUrl = async () => {
				const text = wsUrl;
				let copied = false;
				try {
					const clip = window.navigator?.clipboard || (typeof navigator !== 'undefined' && navigator.clipboard);
					if (clip?.writeText) {
						await clip.writeText(text);
						copied = true;
					}
				} catch {}
				if (!copied) {
					try {
						const ta = document.createElement('textarea');
						ta.value = text;
						ta.setAttribute('readonly', '');
						ta.style.cssText = 'position:fixed;left:-9999px;top:0';
						document.body.appendChild(ta);
						ta.select();
						copied = document.execCommand('copy');
						document.body.removeChild(ta);
					} catch {}
				}
				if (copied) flash('ok', '已复制反向 WebSocket 地址，去 NapCat 里粘贴即可');
				else flash('err', '复制失败，请手动选中地址再复制');
			};
			const personaName = state.persona?.name ?? '(未加载)';
			const num = (value, onChange, extra) =>
				h('input', { className: 'qq_input', type: 'number', value, onChange: (e) => onChange(e.target.value), ...(extra ?? {}) });
			const setPro = (patch) => setProactive({ ...proactive, ...patch });
			const setHum = (patch) => setHuman({ ...human, ...patch });
			const setSoc = (patch) => setSocial({ ...social, ...patch });
			const setGset = (patch) => setGmem({ ...gmem, settings: { ...gmem.settings, ...patch } });
			const ago = (ts) => {
				const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
				return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`;
			};
			const saveRow = (hint, btn) => h('div', { className: 'qq_actions' }, hint ? h('div', { className: 'qq_hint' }, hint) : null, btn);
			const saveBtn = (label, onClick) => h('button', { className: 'qq_btn primary', disabled: busy, onClick }, label);

			// ---------- 概览 ----------
			const pageOverview = () =>
				h(
					Page,
					{ id: 'overview', title: '概览', desc: '她现在的状态一眼看清；点下面的卡片可以直接跳到对应设置。' },
					h(
						'div',
						{ className: 'qq_hero' + (online ? '' : ' bad') },
						h('div', { className: 'qq_hero_ic' }, h(Icon, { name: online ? 'check' : 'plug', size: 24, stroke: 2.2 })),
						h(
							'div',
							null,
							h('div', { className: 'qq_hero_t' }, online ? 'NapCat 已连接' : 'NapCat 未连接'),
							h(
								'div',
								{ className: 'qq_hero_s' },
								online
									? `${personaName} 正在值班，当前有 ${state.stats?.sessions ?? 0} 个活跃会话。`
									: '把下面的地址填进 NapCat 的反向 WebSocket，消息格式选 array。先起本插件，再让 NapCat 连上来。',
							),
						),
					),
					h(
						Card,
						{
							title: '反向 WebSocket',
							desc: '复制后粘贴到 NapCat → 网络配置 → WebSocket 客户端（反向 WS）的 URL。',
						},
						h(
							'div',
							{ className: 'qq_copy' },
							h('input', {
								className: 'qq_input',
								readOnly: true,
								value: wsUrl,
								spellCheck: false,
								onFocus: (e) => e.target.select?.(),
								'aria-label': '反向 WebSocket 地址',
							}),
							h(
								'button',
								{ type: 'button', className: 'qq_btn primary', onClick: copyListenUrl },
								h(Icon, { name: 'copy', size: 14 }),
								'复制',
							),
						),
						state.onebot?.hasToken === false
							? h('div', { className: 'qq_note warn', style: { marginTop: 10 } }, '还没设 onebot.token。建议设一串随机字符，两边填一样的，避免本机其它程序冒充 NapCat。')
							: h('div', { className: 'qq_hint', style: { marginTop: 8 } }, '消息格式必须是 array。改过 token 或端口后，这里会跟着变，再复制一次即可。'),
					),
					h(
						'div',
						{ className: 'qq_stats' },
						h('button', { className: 'qq_stat', onClick: () => setTab('persona') }, h('div', { className: 'qq_stat_l' }, h(Icon, { name: 'user', size: 14 }), '当前角色'), h('div', { className: 'qq_stat_v sm' }, personaName), h('div', { className: 'qq_stat_s' }, state.persona?.tagline ?? ' ')),
						h('button', { className: 'qq_stat', onClick: () => setTab('memory') }, h('div', { className: 'qq_stat_l' }, h(Icon, { name: 'users', size: 14 }), '记得的人'), h('div', { className: 'qq_stat_v' }, memory.profiles.length), h('div', { className: 'qq_stat_s' }, '联系人画像')),
						h('button', { className: 'qq_stat', onClick: () => setTab('memory') }, h('div', { className: 'qq_stat_l' }, h(Icon, { name: 'layers', size: 14 }), '群记忆'), h('div', { className: 'qq_stat_v' }, gmem.groups.length), h('div', { className: 'qq_stat_s' }, gmem.settings.enabled ? '自动总结中' : '已关闭')),
						h('button', { className: 'qq_stat', onClick: () => setTab('stickers') }, h('div', { className: 'qq_stat_l' }, h(Icon, { name: 'smile', size: 14 }), '表情包'), h('div', { className: 'qq_stat_v' }, stickers.count), h('div', { className: 'qq_stat_s' }, '已收藏')),
						h('button', { className: 'qq_stat', onClick: () => setTab('proactive') }, h('div', { className: 'qq_stat_l' }, h(Icon, { name: 'bolt', size: 14 }), '主动发言'), h('div', { className: 'qq_stat_v sm' }, proactive.enabled ? '已开启' : '已关闭'), h('div', { className: 'qq_stat_s' }, lastChime ? `上次开口 ${ago(lastChime)}` : '还没主动开过口')),
						h('button', { className: 'qq_stat', onClick: () => setTab('model') }, h('div', { className: 'qq_stat_l' }, h(Icon, { name: 'cpu', size: 14 }), '模型'), h('div', { className: 'qq_stat_v sm' }, modelInfo?.effective?.model ?? '跟随默认'), h('div', { className: 'qq_stat_s' }, modelInfo?.effective?.reasoningEffort ? `思考强度 ${modelInfo.effective.reasoningEffort}` : '默认思考强度')),
					),
					h(
						Card,
						{ title: '运行情况', desc: '主动发言与群消息的实时统计（重启后清零）。' },
						h(
							'div',
							{ className: 'qq_chips' },
							h('span', { className: 'qq_badge' }, `见到群消息 ${ambientStats.seen ?? 0} 条`),
							h('span', { className: 'qq_badge' }, `其中可接 ${ambientStats.joinable ?? 0} 条`),
							h('span', { className: 'qq_badge' }, `停顿决策 ${ambientStats.pauseTried ?? 0} 次`),
							h('span', { className: 'qq_badge ok' }, `命中开口 ${ambientStats.pauseHit ?? 0} 次`),
						),
						memory.groups.length
							? h('div', { className: 'qq_hint' }, '正在缓冲的群：' + memory.groups.map((g) => `${g.groupId}（${g.size} 条）`).join('、'))
							: null,
					),
					h(
						Card,
						{ title: '她能用的工具', desc: '群里别人问的时候也只能用这些；邮件和发信类工具只在你私聊时开放。' },
						h('div', { className: 'qq_chips' }, (state.stats?.toolAllowlist ?? []).length ? state.stats.toolAllowlist.map((t2) => h('span', { key: t2, className: 'qq_badge' }, t2)) : h('span', { className: 'qq_hint' }, '（无）')),
					),
				);

			// ---------- 角色 ----------
			const pagePersona = () =>
				h(
					Page,
					{ id: 'persona', title: '角色', desc: '她是谁、怎么说话、有什么底线。改完点保存，新会话生效。' },
					h(
						Card,
						{ title: '角色卡', desc: '可以切换、复制或删除角色卡；从当前选中的角色复制一份来改最省事。' },
						h(
							'div',
							{ className: 'qq_row' },
							h(
								'select',
								{ className: 'qq_select', style: { flex: '1 1 260px', maxWidth: 420 }, value: personaFile, onChange: (e) => switchPersona(e.target.value) },
								personas.map((p) => h('option', { key: p.file, value: p.file }, `${p.name} — ${p.tagline}`)),
							),
							h(
								'button',
								{ className: 'qq_btn', onClick: () => { setCreating((v) => !v); setNewName((persona?.name ?? '角色') + '·副本'); } },
								creating ? '取消新建' : '复制新建',
							),
							h('button', { className: 'qq_btn danger' + (confirmKey === 'persona' ? ' armed' : ''), onClick: deletePersona }, confirmKey === 'persona' ? '确认删除' : '删除'),
						),
						creating
							? h(
									'div',
									{ className: 'qq_row' },
									h('input', {
										className: 'qq_input',
										style: { maxWidth: 280 },
										value: newName,
										placeholder: '新角色卡名字',
										onChange: (e) => setNewName(e.target.value),
										onKeyDown: (e) => {
											if (e.key === 'Enter') createPersona(newName);
										},
									}),
									h('button', { className: 'qq_btn primary', onClick: () => createPersona(newName) }, '创建'),
									h('span', { className: 'qq_hint' }, '会以当前选中角色卡为模板复制一份'),
								)
							: null,
					),
					persona
						? h(
								Card,
								{ title: '角色设定' },
								h('div', { className: 'qq_sep' }, '基本信息'),
								h(
									'div',
									{ className: 'qq_grid' },
									h(Field, { label: '名字' }, h('input', { className: 'qq_input', value: persona.name ?? '', onChange: (e) => setP({ name: e.target.value }) })),
									h(Field, { label: '一句话定位' }, h('input', { className: 'qq_input', value: persona.tagline ?? '', onChange: (e) => setP({ tagline: e.target.value }) })),
									h(Field, { label: '形象', wide: true }, h('input', { className: 'qq_input', value: persona.avatar ?? '', onChange: (e) => setP({ avatar: e.target.value }) })),
									h(Field, { label: '她是谁（identity）', wide: true }, h('textarea', { className: 'qq_textarea', style: { minHeight: 110 }, value: persona.identity ?? '', onChange: (e) => setP({ identity: e.target.value }) })),
								),
								h('div', { className: 'qq_sep' }, '性格与说话'),
								h(
									'div',
									{ className: 'qq_grid' },
									h(Field, { label: '性格（每行一条）' }, h('textarea', { className: 'qq_textarea', value: lines(persona.personality), onChange: (e) => setP({ personality: split(e.target.value) }) })),
									h(Field, { label: '语气总述' }, h('input', { className: 'qq_input', value: persona.speech?.tone ?? '', onChange: (e) => setSpeech({ tone: e.target.value }) })),
									h(Field, { label: '口头习惯（每行一条）' }, h('textarea', { className: 'qq_textarea', value: lines(persona.speech?.habits), onChange: (e) => setSpeech({ habits: split(e.target.value) }) })),
									h(Field, { label: '绝对不要说（每行一条）' }, h('textarea', { className: 'qq_textarea', value: lines(persona.speech?.avoid), onChange: (e) => setSpeech({ avoid: split(e.target.value) }) })),
									h(Field, { label: '语气参考示例（每行一条）', wide: true }, h('textarea', { className: 'qq_textarea', style: { minHeight: 100 }, value: lines(persona.speech?.examples), onChange: (e) => setSpeech({ examples: split(e.target.value) }) })),
								),
								h('div', { className: 'qq_sep' }, '底线'),
								h(Field, { label: '边界（每行一条）' }, h('textarea', { className: 'qq_textarea', value: lines(persona.boundaries), onChange: (e) => setP({ boundaries: split(e.target.value) }) })),
								saveRow(`文件：${personaFile}`, saveBtn('保存角色卡', savePersona)),
							)
						: h(Empty, { icon: 'user' }, '正在读取角色卡…'),
				);

			// ---------- 对话规则 ----------
			const pageAccess = () =>
				h(
					Page,
					{ id: 'access', title: '对话规则', desc: '谁能跟她说话、什么时候她会回应，以及别说太快。这一页管「被动回应」。' },
					h(
						Card,
						{ title: '谁能跟她说话' },
						h('div', { className: 'qq_sep' }, '名单'),
						h(
							'div',
							{ className: 'qq_grid' },
							h(Field, { label: '群号（逗号分隔，留空=所有群）' }, h('input', { className: 'qq_input', value: groups, placeholder: '123456, 789012', onChange: (e) => setGroups(e.target.value) })),
							h(Field, { label: 'QQ 号（逗号分隔，留空=所有人）' }, h('input', { className: 'qq_input', value: users, placeholder: '你的 QQ 号', onChange: (e) => setUsers(e.target.value) })),
						),
						h(Toggle, {
							label: '面向白名单群内的所有成员开放',
							desc:
								memberScope === 'group'
									? '白名单群里任何人都能 @ 她、戳她、跟她聊，不用逐个填 QQ 号；私聊仍然只认上面的 QQ 号。'
									: '关闭时：群里只有上面 QQ 号名单里的人能跟她互动（默认）。',
							checked: memberScope === 'group',
							onChange: (e) => setMemberScope(e.target.checked ? 'group' : 'whitelist'),
						}),
						memberScope === 'group' && !groups.trim()
							? h('div', { className: 'qq_note warn' }, '⚠️ 你的群号是空的——这等于对所有群的成员开放。')
							: null,
						h('div', { className: 'qq_sep' }, '群里什么时候回应'),
						h(Seg, {
							value: trigger,
							onChange: (next) => {
								setTrigger(next);
								// 切到 smart 却没写关键词，等于失效，给一组默认值
								if (next === 'smart' && !String(keywords).trim()) setKeywords(DEFAULT_KEYWORDS);
							},
							options: [
								{ value: 'at', label: '被叫到才回', sub: '@ 或戳一戳' },
								{ value: 'smart', label: '叫到或命中关键词', sub: '@ / 关键词' },
								{ value: 'always', label: '每条都接', sub: '慎用' },
							],
						}),
						trigger === 'smart'
							? h(
									Field,
									{ label: '关键词（逗号分隔，命中任意一个就回应）', hint: '子串匹配、忽略大小写：群消息里只要包含其中任意一个词她就会回（仍受频率限制）。留空等于 smart 失效，只认 @。' },
									h('input', { className: 'qq_input', value: keywords, onChange: (e) => setKeywords(e.target.value) }),
								)
							: null,
						h(
							More,
							{ title: '这一页和「主动发言」是什么关系？' },
							'这里管「被动回应」——别人说话、她要不要接；「主动发言」是另一层：先判被动，只有她没接这条，才会走主动发言。' +
								'所以选「每条都接」时，主动发言里「群聊没 @ 她 → 按概率接一句」永远没机会（每条都已经被动回了），但「群静默开话头」仍然有效（静默时没有消息可回）。',
						),
						h('div', { className: 'qq_sep' }, '频率限制'),
						h(
							'div',
							{ className: 'qq_grid' },
							h(Field, { label: '同一个人多久内只回一次', unit: '秒' }, num(cooldown, setCooldown)),
							h(Field, { label: '每群每小时最多回几条', unit: '条' }, num(perGroup, setPerGroup)),
						),
						h('div', { className: 'qq_sep' }, '对话延续'),
						h(
							'div',
							{ className: 'qq_grid' },
							h(
								Field,
								{ label: '对话延续窗口', unit: '秒', hint: '她刚回完后的这段时间里，同一个人不 @ 也接；0=关闭' },
								num(followSec, setFollowSec, { min: 0, max: 3600 }),
							),
							h(
								Field,
								{ label: '最多连续接几次', unit: '次', hint: '超过之后需要重新 @ 她' },
								num(followMax, setFollowMax, { min: 0, max: 20, disabled: Number(followSec) === 0 }),
							),
						),
						h(
							'div',
							{ className: 'qq_grid' },
							h(
								Field,
								{ label: '戳一戳的保鲜期', unit: '秒', hint: '被戳后超过这么久才轮到她处理，或她在这之后已经说过话，就当没看见；0=不限' },
								num(pokeStale, setPokeStale, { min: 0, max: 3600 }),
							),
						),
						h(
							'div',
							{ className: 'qq_hint' },
							'她刚回过你，你紧接着说下一句没 @ 她，也算在跟她说。她自己主动在群里开口之后，这段时间里任何人不 @ 地接话，她都会判断是不是在接她（不是就不吭声）。对方 @ 了别人时不会抢话；引用她发过的消息等同于 @ 她；同一个人几秒内连发的几条会合并成一次回复（见「拟人化」里的连发合并）。',
						),
						saveRow(null, saveBtn('保存对话规则', saveAccess)),
					),
				);

			// ---------- 主动发言 ----------
			const proOff = !proactive.enabled;
			const pageProactive = () =>
				h(
					Page,
					{ id: 'proactive', title: '主动发言', desc: '她没被叫到的时候，会不会自己开口。默认克制：每种触发都有自己的条件，满足才说话。' },
					h(
						Card,
						{ title: '触发方式' },
						h(Toggle, {
							strong: true,
							label: '总开关',
							desc: proactive.enabled ? '下面三种触发都在工作。' : '关闭时，下面三种触发都不会工作。',
							checked: proactive.enabled,
							onChange: (e) => setPro({ enabled: e.target.checked }),
						}),
						h(
							'div',
							{ className: 'qq_sub' + (proOff ? ' off' : '') },
							h(Toggle, {
								label: '群里安静太久 → 开个话头',
								desc: '只对白名单群生效。',
								disabled: proOff,
								checked: proactive.idleEnabled,
								onChange: (e) => setPro({ idleEnabled: e.target.checked, enabled: true }),
							}),
							h('div', { className: 'qq_grid' }, h(Field, { label: '静默多少分钟后', unit: '分钟' }, num(proactive.idleMinutes, (v) => setPro({ idleMinutes: v }), { disabled: proOff || !proactive.idleEnabled }))),
						),
						h(
							'div',
							{ className: 'qq_sub' + (proOff ? ' off' : '') },
							h(Toggle, {
								label: '群聊没 @ 她 → 按概率接一句',
								desc: '只对「像能接的话」生效（疑问句、有内容的陈述），不是每条都跑模型；模型判断不该接会回 PASS，不发送。',
								disabled: proOff,
								checked: proactive.ambientEnabled,
								onChange: (e) => setPro({ ambientEnabled: e.target.checked, enabled: true }),
							}),
							h('div', { className: 'qq_grid' }, h(Field, { label: '采样率（0-1，越小越安静）' }, num(proactive.sampleRate, (v) => setPro({ sampleRate: v }), { step: '0.01', disabled: proOff || !proactive.ambientEnabled }))),
						),
						h(
							'div',
							{ className: 'qq_sub' + (proOff ? ' off' : '') },
							h(Toggle, {
								label: '私聊久没联系 → 主动找她记得的人',
								desc: '只找「聊过至少一次、且建过会话」的人；内容依据是她的画像和上次聊过的事，没有由头会回 PASS。默认关闭，建议观察一段时间再开。',
								disabled: proOff,
								checked: proactive.privateEnabled,
								onChange: (e) => setPro({ privateEnabled: e.target.checked, enabled: true }),
							}),
							h(
								'div',
								{ className: 'qq_grid' },
								h(Field, { label: '多久没说话算「久」', unit: '小时' }, num(proactive.privateIdleHours, (v) => setPro({ privateIdleHours: v }), { disabled: proOff || !proactive.privateEnabled })),
								h(Field, { label: '每天最多主动找几人', unit: '人' }, num(proactive.privateMaxPerDay, (v) => setPro({ privateMaxPerDay: v }), { disabled: proOff || !proactive.privateEnabled })),
							),
						),
						h(
							'div',
							{ className: 'qq_sub' },
							h(Toggle, {
								label: '群聊停顿后 → 考虑接一句',
								desc: '独立开关，不受上面「按概率接一句」影响。不再按单条消息掷骰子：群里安静这么久之后，她拿最近这段对话整体判断一次要不要补一句。',
								checked: proactive.pauseEnabled,
								onChange: (e) => setPro({ pauseEnabled: e.target.checked }),
							}),
							h(
								'div',
								{ className: 'qq_grid' },
								h(Field, { label: '群聊安静多少秒后考虑接一句', unit: '秒', hint: '安静 90 秒 ≈ 一个话题刚聊完' }, num(proactive.pauseSeconds, (v) => setPro({ pauseSeconds: v }), { disabled: !proactive.pauseEnabled })),
								h(Field, { label: '停顿后接话的概率（0-1，越小越安静）' }, num(proactive.pauseSampleRate, (v) => setPro({ pauseSampleRate: v }), { step: '0.05', min: 0, max: 1, disabled: !proactive.pauseEnabled })),
							),
						),
						h('div', { className: 'qq_sep' }, '公共限制'),
						h(
							'div',
							{ className: 'qq_grid' },
							h(Field, { label: '每群每小时最多（条）', unit: '条' }, num(proactive.maxPerHour, (v) => setPro({ maxPerHour: v }))),
							h(Field, { label: '免打扰时段（如 23:30-08:00）' }, h('input', { className: 'qq_input', value: proactive.quietHours, placeholder: '23:30-08:00', onChange: (e) => setPro({ quietHours: e.target.value }) })),
						),
						h(
							'div',
							{ className: 'qq_hint' },
							(lastChime ? `上次她主动开口：${ago(lastChime)}。` : '她还没有主动开口过。') +
								`停顿决策 ${ambientStats.pauseTried ?? 0} 次、命中 ${ambientStats.pauseHit ?? 0} 次；消息 ${ambientStats.seen ?? 0} 条，其中可接 ${ambientStats.joinable ?? 0} 条。受「总开关」「每群每小时最多」「免打扰时段」约束。`,
						),
						saveRow(null, saveBtn('保存主动发言设置', saveProactive)),
					),
				);

			// ---------- 拟人化 ----------
			const pageHuman = () =>
				h(
					Page,
					{ id: 'human', title: '拟人化', desc: '让她像个真人：会打字、会犹豫、会跟着起哄，而不是秒回一大段。' },
					h(
						Card,
						{ title: '说话方式（拟人化）', desc: '真人不会秒回、也不会把所有话塞进一条。关闭总开关她就退回「一条发完、立刻发出」。' },
						h(Toggle, { strong: true, label: '启用打字延迟与连发气泡', checked: human.enabled, onChange: (e) => setHum({ enabled: e.target.checked }) }),
						h('div', { className: 'qq_sep' }, '分条发送'),
						h(
							'div',
							{ className: 'qq_grid' },
							h(Field, { label: '拆成多条的概率（0-1）', hint: '只在有多个句子、且够长时才会触发' }, num(human.splitProbability, (v) => setHum({ splitProbability: v }), { step: '0.05' })),
							h(Field, { label: '最多连发几条', unit: '条' }, num(human.maxBubbles, (v) => setHum({ maxBubbles: v }))),
							h(Field, { label: '少于多少字不拆成多条（0=不限）', unit: '字' }, num(human.minSplitChars, (v) => setHum({ minSplitChars: v }), { min: 0, max: 500 })),
						),
						h('div', { className: 'qq_sep' }, '打字节奏'),
						h(
							'div',
							{ className: 'qq_grid three' },
							h(Field, { label: '每个字多少毫秒（打字速度）', unit: 'ms' }, num(human.perCharMs, (v) => setHum({ perCharMs: v }))),
							h(Field, { label: '最短延迟', unit: 'ms' }, num(human.minTypingMs, (v) => setHum({ minTypingMs: v }))),
							h(Field, { label: '最长延迟', unit: 'ms' }, num(human.maxTypingMs, (v) => setHum({ maxTypingMs: v }))),
						),
						h(
							Toggle,
							{ label: '随时段调整节奏', desc: '深夜更慢、饭点略慢，和她当时的状态一致。', checked: human.timeAware, onChange: (e) => setHum({ timeAware: e.target.checked }) },
						),
						h('div', { className: 'qq_sep' }, '连发合并与文字'),
						h(
							'div',
							{ className: 'qq_grid' },
							h(
								Field,
								{ label: '连发合并：等对方停多久再回（0=关闭）', unit: 'ms', hint: '同一个人在这段时间内连发的几条会合并成一次输入、一次回复，不会答三遍，也不会丢掉中间的话。' },
								num(human.debounceMs, (v) => setHum({ debounceMs: v }), { min: 0, max: 10000 }),
							),
						),
						h(Toggle, { label: '去掉句末句号', desc: '真人打字很少加句号。', checked: human.stripPeriod, onChange: (e) => setHum({ stripPeriod: e.target.checked }) }),
						saveRow('延迟按字数算并带随机抖动。', saveBtn('保存说话方式', saveHuman)),
					),
					h(
						Card,
						{ title: '社交动作（不调用模型）', desc: '只在白名单群里、非免打扰时段生效，并各有冷却，防止刷屏或互戳。' },
						h(Toggle, { label: '复读', desc: '多个人连续说同一句话时，跟一句。', checked: social.repeatEnabled, onChange: (e) => setSoc({ repeatEnabled: e.target.checked }) }),
						h(
							'div',
							{ className: 'qq_grid' },
							h(Field, { label: '复读概率（0-1）' }, num(social.repeatProb, (v) => setSoc({ repeatProb: v }), { step: '0.05', min: 0, max: 1, disabled: !social.repeatEnabled })),
							h(Field, { label: '至少几个不同的人说了同一句', unit: '人' }, num(social.repeatMinUsers, (v) => setSoc({ repeatMinUsers: v }), { min: 2, max: 10, disabled: !social.repeatEnabled })),
						),
						h('div', { className: 'qq_sep' }, '表情回应'),
						h(Toggle, { label: '表情回应', desc: '对好笑 / 夸人 / 可爱的话点个表情，而不是回一句。', checked: social.reactEnabled, onChange: (e) => setSoc({ reactEnabled: e.target.checked }) }),
						h('div', { className: 'qq_grid' }, h(Field, { label: '表情回应概率（0-1）' }, num(social.reactProb, (v) => setSoc({ reactProb: v }), { step: '0.05', min: 0, max: 1, disabled: !social.reactEnabled }))),
						h('div', { className: 'qq_sep' }, '戳一戳'),
						h(Toggle, { label: '被戳时按概率戳回去', desc: '没戳回去时，她仍会回一句。', checked: social.pokeEnabled, onChange: (e) => setSoc({ pokeEnabled: e.target.checked }) }),
						h('div', { className: 'qq_grid' }, h(Field, { label: '戳回去概率（0-1）' }, num(social.pokeProb, (v) => setSoc({ pokeProb: v }), { step: '0.05', min: 0, max: 1, disabled: !social.pokeEnabled }))),
						h(
							More,
							{ title: '冷却规则与限制' },
							'复读 3 分钟、表情回应 3 分钟、戳回去每人 1 分钟且 10 分钟最多 3 次（防止互戳）。戳回去依赖 NapCat 的 packet 后端，不可用时会自动改成让她回一句。',
						),
						saveRow(null, saveBtn('保存社交动作设置', saveSocial)),
					),
				);

			// ---------- 记忆 ----------
			const q = memQuery.trim().toLowerCase();
			const shownProfiles = q ? memory.profiles.filter((p) => String(p.nickname ?? '').toLowerCase().includes(q) || String(p.userId).includes(q)) : memory.profiles;
			const gName = (k) => String(k).replace('group:', '群 ');
			const pageMemory = () =>
				h(
					Page,
					{ id: 'memory', title: '记忆', desc: '她记得谁、记得哪个群的梗。你可以随时手工修改或让她忘掉。' },
					h(
						Card,
						{ title: `联系人画像（${memory.profiles.length} 人）`, desc: '联系人画像：印象词、已知事实和最近的互动，只在和这个人聊天时使用。' },
						h(
							'div',
							{ className: 'qq_split' },
							h(
								'div',
								{ className: 'qq_listcol' },
								memory.profiles.length > 6
									? h('div', { className: 'qq_wrap' }, h('input', { className: 'qq_input', value: memQuery, placeholder: '搜索昵称或 QQ 号', onChange: (e) => setMemQuery(e.target.value) }))
									: null,
								h(
									'div',
									{ className: 'qq_list' },
									shownProfiles.length
										? shownProfiles.map((p) =>
												h(
													'div',
													{ key: p.userId, className: 'qq_item' + (selected?.userId === p.userId ? ' sel' : ''), onClick: () => openProfile(p.userId) },
													h(Avatar, { text: p.nickname, seed: p.userId }),
													h(
														'div',
														{ className: 'qq_item_main' },
														h('div', { className: 'qq_item_name' }, p.nickname),
														h('div', { className: 'qq_item_meta' }, `${p.userId} · 聊过 ${p.interactions} 次 · ${p.episodes} 条记忆`),
														(p.traits ?? []).length ? h('div', { className: 'qq_item_meta' }, (p.traits ?? []).join(' / ')) : null,
													),
												),
											)
										: h(Empty, { icon: 'users' }, memory.profiles.length ? '没有匹配的联系人' : '还没有记住任何人。等有人跟她聊过就会出现在这里。'),
								),
							),
							selected
								? h(
										'div',
										{ className: 'qq_detail' },
										h('div', { className: 'qq_detail_h' }, h(Avatar, { text: selected.nickname, seed: selected.userId }), h('div', null, h('div', { className: 'qq_item_name' }, selected.nickname), h('div', { className: 'qq_item_meta' }, `QQ ${selected.userId}`))),
										h(Field, { label: '印象词（每行一条）' }, h('textarea', { className: 'qq_textarea', value: lines(selected.traits), onChange: (e) => setSelected({ ...selected, traits: split(e.target.value) }) })),
										h(Field, { label: '已知事实（每行一条）' }, h('textarea', { className: 'qq_textarea', value: lines(selected.facts), onChange: (e) => setSelected({ ...selected, facts: split(e.target.value) }) })),
										h('div', { className: 'qq_hint' }, `最近记忆：${(selected.episodes ?? []).slice(-5).map((e) => e.text).join('；') || '（无）'}`),
										h(
											'div',
											{ className: 'qq_actions' },
											h('button', { className: 'qq_btn danger' + (confirmKey === 'profile' ? ' armed' : ''), onClick: deleteProfile }, confirmKey === 'profile' ? '确认忘掉' : '忘掉这个人'),
											h('button', { className: 'qq_btn primary', onClick: saveProfile }, '保存画像'),
										),
									)
								: h(Empty, { icon: 'user' }, '点左边的人查看 / 编辑画像。'),
						),
					),
					h(
						Card,
						{ title: `群记忆（${gmem.groups.length} 个群）`, desc: '记住每个群的梗、称呼关系和最近的话题。只来自该群的发言，也只用在该群，不会带进私聊或别的群。' },
						h(Toggle, { strong: true, label: '让她记住每个群的梗、称呼关系和最近的话题', checked: gmem.settings.enabled, onChange: (e) => setGset({ enabled: e.target.checked }) }),
						h(
							'div',
							{ className: 'qq_grid three' },
							h(Field, { label: '积累多少条新消息后总结一次', unit: '条' }, num(gmem.settings.everyMessages, (v) => setGset({ everyMessages: v }), { min: 5, max: 500, disabled: !gmem.settings.enabled })),
							h(Field, { label: '两次总结至少间隔', unit: '分钟' }, num(gmem.settings.minIntervalMinutes, (v) => setGset({ minIntervalMinutes: v }), { min: 0, max: 1440, disabled: !gmem.settings.enabled })),
							h(Field, { label: '每个群每天最多总结几次', unit: '次' }, num(gmem.settings.maxPerDay, (v) => setGset({ maxPerDay: v }), { min: 0, max: 100, disabled: !gmem.settings.enabled })),
						),
						h('div', { className: 'qq_hint' }, '每次总结会额外调用一次模型（约 80 条消息），在独立的无工具会话里进行，不会往群里发任何东西。'),
						h(
							'div',
							{ className: 'qq_actions' },
							h('button', { className: 'qq_btn', onClick: reloadGmem }, '刷新'),
							h('button', { className: 'qq_btn primary', disabled: busy, onClick: saveGmemSettings }, '保存群记忆设置'),
						),
						h(
							'div',
							{ className: 'qq_split' },
							h(
								'div',
								{ className: 'qq_listcol' },
								h(
									'div',
									{ className: 'qq_list' },
									gmem.groups.length
										? gmem.groups.map((g) =>
												h(
													'div',
													{ key: g.chatKey, className: 'qq_item' + (gmemSel?.chatKey === g.chatKey ? ' sel' : ''), onClick: () => openGmem(g) },
													h(Avatar, { text: '#', seed: g.chatKey, square: true }),
													h(
														'div',
														{ className: 'qq_item_main' },
														h('div', { className: 'qq_item_name' }, gName(g.chatKey)),
														h(
															'div',
															{ className: 'qq_item_meta' },
															`梗 ${g.notes?.lore?.length ?? 0} · 关系 ${g.notes?.relations?.length ?? 0} · 话题 ${g.notes?.topics?.length ?? 0} · 总结 ${g.summaries} 次${g.running ? ' · 正在总结…' : ''}`,
														),
													),
												),
											)
										: h(Empty, { icon: 'layers' }, '还没有群记忆。群里积累够消息后会自动出现在这里。'),
								),
							),
							gmemSel
								? h(
										'div',
										{ className: 'qq_detail' },
										h('div', { className: 'qq_detail_h' }, h(Avatar, { text: '#', seed: gmemSel.chatKey, square: true }), h('div', null, h('div', { className: 'qq_item_name' }, gName(gmemSel.chatKey)), h('div', { className: 'qq_item_meta' }, '改完保存立刻生效'))),
										h(Field, { label: '群里的梗 / 黑话（每行一条）' }, h('textarea', { className: 'qq_textarea', value: lines(gmemSel.lore), onChange: (e) => setGmemSel({ ...gmemSel, lore: split(e.target.value) }) })),
										h(Field, { label: '称呼与关系（每行一条）' }, h('textarea', { className: 'qq_textarea', value: lines(gmemSel.relations), onChange: (e) => setGmemSel({ ...gmemSel, relations: split(e.target.value) }) })),
										h(Field, { label: '最近在聊的话题（每行一条，最多 5 条）' }, h('textarea', { className: 'qq_textarea', value: lines(gmemSel.topics), onChange: (e) => setGmemSel({ ...gmemSel, topics: split(e.target.value) }) })),
										h(
											'div',
											{ className: 'qq_actions' },
											h('button', { className: 'qq_btn danger' + (confirmKey === 'gmem' ? ' armed' : ''), onClick: removeGmem }, confirmKey === 'gmem' ? '确认清空' : '清空这个群的记忆'),
											h('button', { className: 'qq_btn', onClick: summarizeGmem }, '立即总结一次'),
											h('button', { className: 'qq_btn primary', onClick: saveGmemNotes }, '保存'),
										),
									)
								: h(Empty, { icon: 'layers' }, '点左边的群查看 / 编辑记忆。'),
						),
					),
				);

			// ---------- 表情包 ----------
			const pageStickers = () =>
				h(
					Page,
					{ id: 'stickers', title: '表情包', desc: '收到的表情包会按内容去重收藏，她想发的时候按标签挑一张。' },
					h(
						Card,
						{ title: `表情包库（${stickers.count} 张）` },
						h(
							'div',
							{ className: 'qq_grid' },
							h(
								Field,
								{ label: '自动收藏' },
								h(
									'select',
									{ className: 'qq_select', value: stickers.autoSave, onChange: (e) => setStickerMode(e.target.value) },
									h('option', { value: 'stickers' }, '只存表情包（推荐）'),
									h('option', { value: 'all' }, '所有图片都存'),
									h('option', { value: 'off' }, '不自动存'),
								),
							),
							h(
								Field,
								{ label: '看图方式' },
								h(
									'select',
									{ className: 'qq_select', value: stickers.visionMode, onChange: (e) => setVisionMode(e.target.value) },
									h('option', { value: 'onDemand' }, '按需查看（省 token，推荐）'),
									h('option', { value: 'always' }, '每张图都直接发给她看（费 token）'),
									h('option', { value: 'off' }, '完全不让她看图'),
								),
							),
						),
						h(
							More,
							{ title: '她是怎么用表情包的？' },
							'收到表情包会下载到 data/stickers/ 并按内容去重。她想发时回复里写 [[表情:关键词]]，桥按标签 / 上下文 / 同义词挑一张；没匹配到就不发。她看完图觉得值得记，会打 [[标签:搞笑,敷衍]]，标签越多以后越容易命中。表情发出去后 120 秒内的回复会被当作评价，好评加分、差评扣分并冷却。',
						),
						stickers.items.length
							? h(
									'div',
									{ className: 'qq_stickers' },
									stickers.items.slice(0, 48).map((s) =>
										h(
											'div',
											{ key: s.hash, className: 'qq_sticker' },
											h('img', { src: '/dsh-qq/api/stickers/file?hash=' + encodeURIComponent(s.hash), alt: s.tags || s.context || '表情包', loading: 'lazy' }),
											h('div', { className: 'qq_sticker_tag', title: s.context ?? '' }, (s.tags || s.context || '').slice(0, 12) || '未标注'),
											h('button', { className: 'qq_sticker_del', title: '删除这张', 'aria-label': '删除这张', onClick: () => removeSticker(s.hash) }, '×'),
										),
									),
								)
							: h(Empty, { icon: 'smile' }, '还没有收藏到表情包。等群里有人发表情她就会记下来。'),
						stickers.items.length > 48 ? h('div', { className: 'qq_hint' }, `只显示最近 48 张，共 ${stickers.count} 张。`) : null,
					),
				);

			// ---------- 模型与邮件 ----------
			const pageModel = () =>
				h(
					Page,
					{ id: 'model', title: '模型与邮件', desc: '她用哪个模型思考，以及要不要帮你看邮件。' },
					h(
						Card,
						{ title: '模型与思考强度' },
						h(
							'div',
							{ className: 'qq_note' },
							modelInfo?.host
								? `宿主默认：${modelInfo.host.provider} / ${modelInfo.host.model}${modelInfo.host.reasoningEffort ? ' / ' + modelInfo.host.reasoningEffort : ''}`
								: '宿主默认：未知（会跟随当前应用的模型设置）',
						),
						h(
							'div',
							{ className: 'qq_grid three' },
							h(Field, { label: 'provider（留空=跟随默认）' }, h('input', { className: 'qq_input', value: modelCfg.provider, placeholder: '例如 deepseek', onChange: (e) => setModelCfg({ ...modelCfg, provider: e.target.value }) })),
							h(Field, { label: 'model（留空=跟随默认）' }, h('input', { className: 'qq_input', value: modelCfg.model, placeholder: '例如 deepseek-flash', onChange: (e) => setModelCfg({ ...modelCfg, model: e.target.value }) })),
							h(
								Field,
								{ label: '思考强度' },
								h(
									'select',
									{ className: 'qq_select', value: modelCfg.reasoningEffort, onChange: (e) => setModelCfg({ ...modelCfg, reasoningEffort: e.target.value }) },
									h('option', { value: '' }, '跟随默认'),
									h('option', { value: 'off' }, '关闭思考'),
									h('option', { value: 'low' }, '低（快、省）'),
									h('option', { value: 'medium' }, '中'),
									h('option', { value: 'high' }, '高（慢、贵、更稳）'),
									h('option', { value: 'xhigh' }, '极高（xhigh）'),
									h('option', { value: 'max' }, '最大（max，最慢最贵）'),
								),
							),
						),
						h(
							'div',
							{ className: 'qq_hint' },
							'当前生效：' +
								(modelInfo?.effective ? `${modelInfo.effective.provider} / ${modelInfo.effective.model}${modelInfo.effective.reasoningEffort ? ' / ' + modelInfo.effective.reasoningEffort : ' / 默认强度'}` : '跟随宿主默认') +
								'。写错 provider/model 时会自动回退到宿主默认，不会把会话搞挂；但已经建好的会话不会换模型，需要点「重建会话」。',
						),
						h(
							'div',
							{ className: 'qq_actions' },
							h('button', { className: 'qq_btn', disabled: busy, onClick: () => saveModel(true) }, '重建会话（让新配置立即生效）'),
							h('button', { className: 'qq_btn primary', disabled: busy, onClick: () => saveModel(false) }, '保存模型配置'),
						),
					),
					h(
						Card,
						{ title: '邮件助理', desc: '用的是应用里已经配好的邮箱（就是你自己会话里能用的那个邮件账号）。' },
						h(Toggle, { strong: true, label: '允许她帮我看邮件', checked: mailCfg.enabled, onChange: (e) => setMailCfg({ ...mailCfg, enabled: e.target.checked }) }),
						h('div', { className: 'qq_grid' }, h(Field, { label: '多久巡查一次（最小 5）', unit: '分钟' }, num(mailCfg.watchMinutes, (v) => setMailCfg({ ...mailCfg, watchMinutes: v }), { disabled: !mailCfg.enabled }))),
						h(
							'div',
							{ className: 'qq_note' },
							'她只能读：mail_find / mail_read / mail_list_folders 仅在你私聊她时可用，群里、别人问都拿不到。发邮件（mail_send）一直禁用。巡查发现重要邮件会私信你；没有就安静。',
						),
						saveRow(null, saveBtn('保存邮件设置', saveMail)),
					),
				);

			const pages = {
				overview: pageOverview,
				persona: pagePersona,
				access: pageAccess,
				proactive: pageProactive,
				human: pageHuman,
				memory: pageMemory,
				stickers: pageStickers,
				model: pageModel,
			};
			const navDot = { proactive: proactive.enabled };

			return h(
				'div',
				{ className: 'qq_app' },
				toast,
				header(
					`${personaName}${state.persona?.tagline ? ' · ' + state.persona.tagline : ''}`,
					h('span', { className: 'qq_pill ' + (online ? 'ok' : 'warn') }, h('span', { className: 'dot' }), online ? 'NapCat 已连接' : 'NapCat 未连接'),
				),
				h(
					'div',
					{ className: 'qq_body' },
					h(
						'nav',
						{ className: 'qq_nav', 'aria-label': 'QQ 机器人设置' },
						TABS.map((x) =>
							h(
								'button',
								{ key: x.id, type: 'button', className: 'qq_nav_item' + (tab === x.id ? ' on' : ''), 'aria-current': tab === x.id ? 'page' : undefined, onClick: () => setTab(x.id) },
								h(Icon, { name: x.icon, size: 16 }),
								h('span', null, x.label),
								navDot[x.id] ? h('span', { className: 'qq_nav_dot', title: '已开启' }) : null,
							),
						),
					),
					h('div', { className: 'qq_content', ref: contentRef }, h(react.Fragment, { key: tab }, (pages[tab] ?? pageOverview)())),
				),
			);
		}

		function apply(ctx) {
			const own = (register) => {
				if (ctx.effect) ctx.effect(register);
				else register();
			};
			own(() =>
				ctx.locale.register(NS, {
					zh: { nav: 'QQ 机器人' },
					en: { nav: 'QQ Bot' },
				}),
			);
			const t = ctx.locale.bind(NS);
			// 主界面面板：key 与侧边栏入口的 id 相同，点入口就显示它
			own(() =>
				ctx.slots.inject('main', () =>
					ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, QqPanel),
				),
			);
			// 侧边栏入口：全局面板行，位于「工作区」区块上方
			own(() =>
				ctx.slots.inject('sidebar.panellist', () =>
					ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 8, label: () => t('nav'), locale: NS }, QqIcon),
				),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
