/**
 * Wrap rendered Mermaid SVGs with pan / zoom / fullscreen controls.
 * astro-mermaid leaves <pre class="mermaid"> until the client script swaps in SVG.
 */
(() => {
	const ICONS = {
		plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
		minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M8 12h8"/></svg>',
		// Fit = arrows pulling inward; fullscreen = corners pushing outward.
		fit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>',
		full: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
		close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>',
	};

	function button(action, label, icon, extraClass = '') {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.dataset.act = action;
		btn.className = `mw-icon-btn ${extraClass}`.trim();
		btn.setAttribute('aria-label', label);
		btn.title = label;
		btn.innerHTML = `${icon}<span>${label}</span>`;
		return btn;
	}

	function attachPanZoom(stage) {
		const canvas = stage.querySelector('.mw-diagram__canvas');
		if (!canvas || canvas.dataset.mwPan === '1') return;
		canvas.dataset.mwPan = '1';

		const state = { scale: 1, x: 0, y: 0, px: 0, py: 0, dragging: false };

		const apply = () => {
			canvas.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
		};

		const fit = () => {
			const svg = canvas.querySelector('svg');
			if (!svg) return;
			const box = svg.getBBox?.() ?? { width: svg.clientWidth, height: svg.clientHeight };
			const pad = 32;
			const sw = Math.max(box.width, 1);
			const sh = Math.max(box.height, 1);
			const scale = Math.min(
				(stage.clientWidth - pad) / sw,
				(stage.clientHeight - pad) / sh,
				1.5,
			);
			state.scale = Number.isFinite(scale) && scale > 0 ? scale : 1;
			state.x = (stage.clientWidth - sw * state.scale) / 2 - (box.x || 0) * state.scale;
			state.y = (stage.clientHeight - sh * state.scale) / 2 - (box.y || 0) * state.scale;
			apply();
		};

		const zoomAt = (clientX, clientY, factor) => {
			const rect = stage.getBoundingClientRect();
			const cx = clientX - rect.left;
			const cy = clientY - rect.top;
			const next = Math.min(6, Math.max(0.2, state.scale * factor));
			const k = next / state.scale;
			state.x = cx - (cx - state.x) * k;
			state.y = cy - (cy - state.y) * k;
			state.scale = next;
			apply();
		};

		stage.addEventListener(
			'wheel',
			(event) => {
				event.preventDefault();
				zoomAt(event.clientX, event.clientY, event.deltaY < 0 ? 1.12 : 1 / 1.12);
			},
			{ passive: false },
		);

		// Two-finger pinch: touchscreens never send the ctrl+wheel a trackpad does.
		const pointers = new Map();
		let pinchDist = 0;

		const spread = () => {
			const [a, b] = [...pointers.values()];
			return {
				dist: Math.hypot(a.x - b.x, a.y - b.y),
				cx: (a.x + b.x) / 2,
				cy: (a.y + b.y) / 2,
			};
		};

		stage.addEventListener('pointerdown', (event) => {
			if (event.pointerType === 'mouse' && event.button !== 0) return;
			pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
			stage.setPointerCapture(event.pointerId);

			if (pointers.size === 2) {
				// Second finger down: stop panning, start pinching.
				state.dragging = false;
				stage.classList.remove('is-panning');
				pinchDist = spread().dist;
				return;
			}
			if (pointers.size > 2) return;

			state.dragging = true;
			state.px = event.clientX;
			state.py = event.clientY;
			stage.classList.add('is-panning');
		});

		stage.addEventListener('pointermove', (event) => {
			if (pointers.has(event.pointerId)) {
				pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
			}

			if (pointers.size === 2) {
				const { dist, cx, cy } = spread();
				if (pinchDist > 0 && dist > 0) zoomAt(cx, cy, dist / pinchDist);
				pinchDist = dist;
				return;
			}

			if (!state.dragging) return;
			state.x += event.clientX - state.px;
			state.y += event.clientY - state.py;
			state.px = event.clientX;
			state.py = event.clientY;
			apply();
		});

		const endDrag = (event) => {
			pointers.delete(event.pointerId);
			pinchDist = 0;

			// Lifting one finger of a pinch: hand the pan back to the finger left behind.
			const [remaining] = pointers.values();
			if (remaining) {
				state.dragging = true;
				state.px = remaining.x;
				state.py = remaining.y;
				stage.classList.add('is-panning');
				return;
			}

			state.dragging = false;
			stage.classList.remove('is-panning');
			if (stage.hasPointerCapture?.(event.pointerId)) stage.releasePointerCapture(event.pointerId);
		};
		stage.addEventListener('pointerup', endDrag);
		stage.addEventListener('pointercancel', endDrag);

		stage.addEventListener('dblclick', (event) => {
			event.preventDefault();
			fit();
		});

		requestAnimationFrame(fit);
		return { zoomAt, fit, state };
	}

	function enhanceHost(host) {
		if (!(host instanceof Element)) return;
		if (host.dataset.mwEnhanced === '1' || host.closest('.mw-diagram-dialog')) return;

		const svg = [...host.querySelectorAll('svg')].find((node) => !node.parentElement?.closest('svg'));
		if (!svg) return;

		host.dataset.mwEnhanced = '1';
		host.classList.add('mw-diagram');
		host.setAttribute('role', 'group');
		host.setAttribute('aria-label', 'Diagram with pan and zoom');

		const toolbar = document.createElement('div');
		toolbar.className = 'mw-diagram__toolbar';
		const hint = document.createElement('span');
		hint.className = 'mw-diagram__hint';
		hint.textContent = 'Scroll or pinch to zoom · drag to pan';
		toolbar.append(
			button('in', 'Zoom in', ICONS.plus),
			button('out', 'Zoom out', ICONS.minus),
			button('fit', 'Fit', ICONS.fit),
			(() => {
				const el = document.createElement('span');
				el.className = 'mw-spacer';
				return el;
			})(),
			hint,
			button('full', 'Fullscreen', ICONS.full),
		);

		const stage = document.createElement('div');
		stage.className = 'mw-diagram__stage';
		const canvas = document.createElement('div');
		canvas.className = 'mw-diagram__canvas';
		canvas.append(svg);
		stage.append(canvas);
		host.replaceChildren(toolbar, stage);

		const controls = attachPanZoom(stage);

		toolbar.addEventListener('click', (event) => {
			const btn = event.target.closest('button[data-act]');
			if (!btn || !controls) return;
			const act = btn.dataset.act;
			const rect = stage.getBoundingClientRect();
			const cx = rect.left + rect.width / 2;
			const cy = rect.top + rect.height / 2;
			if (act === 'in') controls.zoomAt(cx, cy, 1.25);
			else if (act === 'out') controls.zoomAt(cx, cy, 0.8);
			else if (act === 'fit') controls.fit();
			else if (act === 'full') openFullscreen(svg);
		});
	}

	function scan() {
		document.querySelectorAll('pre.mermaid, div.mermaid').forEach(enhanceHost);
	}

	function openFullscreen(svg) {
		let dialog = document.getElementById('mw-diagram-dialog');
		if (!dialog) {
			dialog = document.createElement('dialog');
			dialog.id = 'mw-diagram-dialog';
			dialog.className = 'mw-diagram-dialog';
			document.body.append(dialog);
			dialog.addEventListener('click', (event) => {
				if (event.target === dialog) dialog.close();
			});
		}

		dialog.innerHTML = '';
		const figure = document.createElement('figure');
		figure.className = 'mw-diagram';
		const toolbar = document.createElement('div');
		toolbar.className = 'mw-diagram__toolbar';
		const hint = document.createElement('span');
		hint.className = 'mw-diagram__hint';
		hint.textContent = 'Scroll / pinch to zoom · drag to pan · Esc to close';
		toolbar.append(
			button('in', 'Zoom in', ICONS.plus),
			button('out', 'Zoom out', ICONS.minus),
			button('fit', 'Fit', ICONS.fit),
			(() => {
				const el = document.createElement('span');
				el.className = 'mw-spacer';
				return el;
			})(),
			hint,
			button('close', 'Close', ICONS.close),
		);
		const stage = document.createElement('div');
		stage.className = 'mw-diagram__stage';
		const canvas = document.createElement('div');
		canvas.className = 'mw-diagram__canvas';
		canvas.append(svg.cloneNode(true));
		stage.append(canvas);
		figure.append(toolbar, stage);
		dialog.append(figure);
		dialog.showModal();

		const controls = attachPanZoom(stage);
		toolbar.addEventListener('click', (event) => {
			const btn = event.target.closest('button[data-act]');
			if (!btn || !controls) return;
			const act = btn.dataset.act;
			const rect = stage.getBoundingClientRect();
			const cx = rect.left + rect.width / 2;
			const cy = rect.top + rect.height / 2;
			if (act === 'in') controls.zoomAt(cx, cy, 1.25);
			else if (act === 'out') controls.zoomAt(cx, cy, 0.8);
			else if (act === 'fit') controls.fit();
			else if (act === 'close') dialog.close();
		});
	}

	const start = () => {
		scan();
		const obs = new MutationObserver(scan);
		obs.observe(document.body, { childList: true, subtree: true });
	};

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
	else start();
})();
