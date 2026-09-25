// @camusugar/dsh-notify — Client plugin artifact, hand-written in the standard
// @deepseek-ai client bundle format (window.__ModuleLoader__.load row).
//
// Shows one OS system notification per pending user interaction
// (approval / question / plan review) while the application window is not
// visible or focused. The notification closes when the interaction is answered
// or the user returns to the window.
//
// Performance contract: event-driven only. Exactly one subscription to
// uiSession.sessionStatus plus three standard DOM visibility/focus listeners,
// all registered as one Cordis effect. No timers, no polling, no React, no DOM
// writes. Per-callback work is a single pass over the (few) live session
// statuses and a small bounded Map of open notifications.
//
// Failure contract: any unexpected service shape degrades to a silent no-op;
// this plugin never throws into the Cordis loader or the shared publisher loop.

window.__ModuleLoader__.load({
	id: "@camusugar/dsh-notify",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const MAX_NOTES = 16;
		const MAX_TEXT = 200;

		const isZh = typeof navigator !== "undefined"
			&& String(navigator.language ?? "").toLowerCase().startsWith("zh");

		const copy = isZh
			? {
				titleApproval: "DeepSeek Harness 等待你批准",
				titleQuestion: "DeepSeek Harness 等待你回答",
				titlePlan: "DeepSeek Harness 等待你确认方案",
				fallback: "一个会话需要你处理",
			}
			: {
				titleApproval: "DeepSeek Harness needs your approval",
				titleQuestion: "DeepSeek Harness needs your answer",
				titlePlan: "DeepSeek Harness needs your plan review",
				fallback: "a DSH session needs your action",
			};

		function clip(value, max) {
			const s = String(value ?? "").replace(/\s+/g, " ").trim();
			return s.length > max ? s.slice(0, max - 1) + "…" : s;
		}

		function noteTitle(pi) {
			switch (pi.kind) {
				case "approval": return copy.titleApproval;
				case "question": return copy.titleQuestion;
				case "plan-review":
				case "plan": return copy.titlePlan;
				default: return copy.fallback;
			}
		}

		function noteBody(pi, label) {
			switch (pi.kind) {
				case "approval": {
					const tool = pi.toolName ? clip(pi.toolName, 40) : "";
					const reason = clip(pi.displayReason ?? pi.reason, 100);
					return [label, tool, reason].filter(Boolean).join(" — ");
				}
				case "question": {
					const q = Array.isArray(pi.questions)
						? pi.questions.find((x) => x && typeof x.question === "string")
						: undefined;
					const text = q ? clip(q.question, 140) : "";
					return [label, text].filter(Boolean).join(" — ");
				}
				default: return label;
			}
		}

		function permissionReady() {
			if (Notification.permission === "granted") return Promise.resolve(true);
			if (Notification.permission === "denied") return Promise.resolve(false);
			if (typeof Notification.requestPermission !== "function") return Promise.resolve(false);
			return Promise.resolve(Notification.requestPermission())
				.then((p) => p === "granted")
				.catch(() => Notification.permission === "granted");
		}

		/**
		 * Install the pending-interaction observer as one Cordis effect.
		 * @param ctx - Client Cordis root context.
		 */
		function apply(ctx) {
			try {
				const uiSession = typeof ctx.get === "function" ? ctx.get("uiSession") : ctx.uiSession;
				const status = uiSession && uiSession.sessionStatus;
				if (!status || typeof status.subscribe !== "function" || typeof status.getSnapshot !== "function") return;
				if (typeof Notification === "undefined" || Notification.permission === "denied") return;

				// Optional: human-facing session label so several concurrent
				// pending sessions stay distinguishable in the flyout. A plain
				// snapshot read at raise time; absence or drift means no label.
				const sessions = typeof ctx.get === "function" ? ctx.get("sessions") : ctx.sessions;
				const sessionLabel = (sessionId) => {
					try {
						const byId = sessions && sessions.list && typeof sessions.list.getSnapshot === "function"
							? sessions.list.getSnapshot()?.byId
							: undefined;
						const row = byId ? byId[sessionId] : undefined;
						return row && typeof row.displayTitle === "string" && row.displayTitle !== "" ? row.displayTitle : "";
					} catch {
						return "";
					}
				};

				ctx.effect(() => {
					const notes = new Map(); // pending key -> Notification
					let away = false;
					let suppressed = false;
					let disabled = false;
					let offSync = () => {};

					const closeAll = () => {
						for (const note of notes.values()) {
							try { note.close(); } catch { /* already gone */ }
						}
						notes.clear();
					};

					const raise = (pi) => {
						void permissionReady().then((granted) => {
							if (!granted) {
								console.warn("dsh-notify: permission not granted (" + Notification.permission + "), skipping " + pi.key);
								return;
							}
							if (notes.has(pi.key)) return;
							if (notes.size >= MAX_NOTES) {
								if (!suppressed) {
									suppressed = true;
									console.warn("dsh-notify: more than " + MAX_NOTES + " pending interactions; suppressing further notifications");
								}
								return;
							}
							let note;
							try {
								note = new Notification(noteTitle(pi), {
									body: noteBody(pi, sessionLabel(pi.sessionId)),
									tag: "dsh-notify:" + pi.key,
								});
							} catch (error) {
								console.warn("dsh-notify: new Notification threw", error);
								return;
							}
							note.onclick = () => {
								try { window.focus(); } catch { /* window gone */ }
								try { note.close(); } catch { /* already gone */ }
							};
							notes.set(pi.key, note);
						});
					};

					const sync = () => {
						if (disabled) return;
						try {
							if (!away) {
								closeAll();
								return;
							}
							const snapshot = status.getSnapshot();
							if (!snapshot || typeof snapshot.values !== "function") return;
							const live = new Map();
							for (const entry of snapshot.values()) {
								const pi = entry && entry.pendingInteraction;
								if (pi) live.set(pi.key, pi);
							}
							for (const [key, pi] of live) {
								if (!notes.has(key)) raise(pi);
							}
							for (const key of [...notes.keys()]) {
								if (!live.has(key)) {
									try { notes.get(key).close(); } catch { /* already gone */ }
									notes.delete(key);
								}
							}
						} catch (error) {
							// Unexpected snapshot shape: disarm instead of breaking
							// the shared publisher loop.
							disabled = true;
							console.warn("dsh-notify: disabled", error);
							offSync();
							closeAll();
						}
					};

					const updateAway = () => {
						away = document.visibilityState !== "visible" || !document.hasFocus();
						sync();
					};

					document.addEventListener("visibilitychange", updateAway);
					window.addEventListener("blur", updateAway);
					window.addEventListener("focus", updateAway);
					away = document.visibilityState !== "visible" || !document.hasFocus();

					const off = status.subscribe(sync);
					offSync = () => { off(); offSync = () => {}; };
					sync();
					console.log("dsh-notify: armed");

					return () => {
						off();
						document.removeEventListener("visibilitychange", updateAway);
						window.removeEventListener("blur", updateAway);
						window.removeEventListener("focus", updateAway);
						closeAll();
					};
				}, "dsh-notify: pending-interaction system notifications");
			} catch (error) {
				console.warn("dsh-notify: disabled", error);
			}
		}

		exports.apply = apply;
		exports.inject = ["uiSession"];
		return module.exports;
	}
});
