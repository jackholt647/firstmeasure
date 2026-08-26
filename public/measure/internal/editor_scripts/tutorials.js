(function () {
    'use strict';

    function tutorialState() {
        return (window.FIRSTMEASURE_TUTORIAL && window.FIRSTMEASURE_TUTORIAL.enabled)
            ? window.FIRSTMEASURE_TUTORIAL
            : null;
    }

    function isTutorialProjectId(projectId) {
        return /^tutorial_[a-f0-9]{16,64}$/i.test(String(projectId || '').trim());
    }

    function setOverlay(on, text) {
        const overlay = document.getElementById('loadingOverlay');
        const loadingText = document.getElementById('loadingText');
        if (!overlay || !loadingText) return;
        overlay.style.display = on ? 'flex' : 'none';
        if (text) loadingText.innerText = text;
    }

    function ensureTutorialProjectId() {
        const projectId = String(window.currentProjectId || tutorialState()?.projectId || '').trim();
        if (!isTutorialProjectId(projectId)) {
            throw new Error('Tutorial mode can only save tutorial project IDs.');
        }
        return projectId;
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[ch]));
    }

    function scoreColor(value) {
        if (value === null || value === undefined || value === '') return '#b06000';
        const score = Number(value);
        if (!Number.isFinite(score)) return '#b06000';
        if (score < 60) return '#a50e0e';
        if (score < 75) return '#d97706';
        if (score < 90) return '#b58900';
        return '#188038';
    }

    function renderScoreBreakdown(scoreDetails) {
        const categories = scoreDetails && scoreDetails.categories && typeof scoreDetails.categories === 'object'
            ? Object.values(scoreDetails.categories)
            : [];
        if (!categories.length) return '';
        return `
            <div class="tutorial-score-breakdown">
                ${categories.map((cat) => {
                    const score = Number(cat.score);
                    const max = Number(cat.max_score);
                    const diff = Number(cat.diff_percent);
                    const status = String(cat.status || '');
                    const statusText = status === 'correct' ? 'Good' : (status === 'partial' ? 'Close' : 'Missed');
                    const pct = Number.isFinite(score) && Number.isFinite(max) && max > 0 ? (score / max) * 100 : null;
                    const color = scoreColor(pct);
                    return `
                        <div class="tutorial-score-row">
                            <span>${escapeHtml(cat.label || cat.key || 'Metric')}</span>
                            <strong style="color:${color};">${Number.isFinite(score) && Number.isFinite(max) ? `${Math.round(score)}/${Math.round(max)}` : statusText}</strong>
                            ${Number.isFinite(diff) ? `<em>${diff}% off</em>` : ''}
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    }

    function ensureStyles() {
        if (document.getElementById('tutorialEditorStyles')) return;
        const style = document.createElement('style');
        style.id = 'tutorialEditorStyles';
        style.textContent = `
            .tutorial-mode-ribbon {
                background: #202124;
                color: #fff;
                border: 1.5px solid #202124;
                border-radius: 20px;
                padding: 3px 10px;
                font-size: 11px;
                font-weight: 800;
                display: inline-flex;
                align-items: center;
                gap: 6px;
                margin-left: 3px;
                white-space: nowrap;
                vertical-align: middle;
                pointer-events: none;
            }
            .claim-timer.tutorial-timer {
                color: #1a73e8;
            }
            .claim-timeline.tutorial-hidden {
                display: none !important;
            }
            .tutorial-result-backdrop {
                position: fixed;
                inset: 0;
                z-index: 1000003;
                display: flex;
                align-items: center;
                justify-content: center;
                background: rgba(16,24,40,.72);
                backdrop-filter: blur(4px);
                padding: 24px;
            }
            .tutorial-result-modal {
                width: min(440px, 100%);
                background: #fff;
                border-radius: 12px;
                box-shadow: 0 22px 70px rgba(0,0,0,.34);
                overflow: hidden;
                text-align: center;
            }
            .tutorial-result-head { padding: 24px 24px 14px; }
            .tutorial-result-head h2 { margin: 0; font-size: 22px; color: #202124; }
            .tutorial-result-head p { margin: 8px 0 0; font-size: 12px; font-weight: 700; color: #667085; }
            .tutorial-score { padding: 8px 24px 22px; }
            .tutorial-score .value { font-size: 44px; font-weight: 900; color: #188038; line-height: 1; }
            .tutorial-score .label { margin-top: 8px; font-size: 12px; font-weight: 800; color: #667085; }
            .tutorial-score-breakdown { margin: 0 24px 18px; border: 1px solid #edf0f5; border-radius: 10px; overflow: hidden; text-align: left; }
            .tutorial-score-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 10px; align-items: center; padding: 9px 11px; border-top: 1px solid #edf0f5; font-size: 12px; color: #344054; }
            .tutorial-score-row:first-child { border-top: none; }
            .tutorial-score-row strong { color: #202124; }
            .tutorial-score-row em { color: #667085; font-style: normal; font-size: 11px; }
            .tutorial-progress-note { padding: 0 24px 16px; font-size: 13px; font-weight: 800; color: #344054; }
            .tutorial-result-actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; padding: 16px 22px 22px; border-top: 1px solid #edf0f5; }
            .tutorial-result-actions button {
                border: none;
                border-radius: 8px;
                padding: 12px 10px;
                color: #fff;
                font-weight: 900;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 8px;
                font-size: 12px;
            }
            .tutorial-back { background: #d93025; }
            .tutorial-stay { background: #1a73e8; }
            .tutorial-next { background: #188038; }
            .tutorial-result-actions button[hidden] { display: none; }
            .tutorial-result-actions:has(button[hidden] + button[hidden]) { grid-template-columns: 1fr; }
        `;
        document.head.appendChild(style);
    }

    function showRibbon() {
        if (!tutorialState() || document.getElementById('tutorialModeRibbon')) return;
        ensureStyles();
        const ribbon = document.createElement('div');
        ribbon.id = 'tutorialModeRibbon';
        ribbon.className = 'tutorial-mode-ribbon';
        ribbon.innerHTML = '<i class="fas fa-graduation-cap"></i><span>Tutorial Mode</span>';
        const anchor = document.getElementById('structure-count-badge') || document.getElementById('project-type-badge');
        if (anchor && anchor.parentNode) {
            anchor.parentNode.insertBefore(ribbon, anchor.nextSibling);
            return;
        }
        const logoArea = document.querySelector('.logo-area');
        if (logoArea) {
            logoArea.appendChild(ribbon);
            return;
        }
        document.body.appendChild(ribbon);
    }

    function formatElapsed(ms) {
        const totalSeconds = Math.max(0, Math.floor(ms / 1000));
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
    }

    function renderTutorialTimer() {
        const timer = document.getElementById('claimElapsedTimer');
        const state = window.firstMeasureTutorialTimerState;
        if (!timer || !state) return;
        const manifest = window.currentProjectManifest || {};
        const dueAtMs = manifest.test_due_at ? Date.parse(manifest.test_due_at) : 0;
        if (Number.isFinite(dueAtMs) && dueAtMs > 0) {
            const remaining = Math.max(0, dueAtMs - Date.now());
            const completed = Math.max(0, Number(manifest.test_completed_count || 0));
            const total = Math.max(0, Number(manifest.test_project_count || manifest.test_sequence_total || 0));
            const progress = total > 0 ? `${Math.min(completed, total)}/${total} | ` : '';
            timer.textContent = `${progress}${formatElapsed(remaining)}`;
            timer.title = 'Test time remaining';
            timer.style.color = remaining <= 300000 ? '#a50e0e' : '#1a73e8';
            return;
        }
        if (!state.startedAtMs) return;
        timer.textContent = formatElapsed(Date.now() - state.startedAtMs);
        timer.title = 'Tutorial elapsed time';
        timer.style.color = '';
    }

    function isDraftRejectProject() {
        const manifest = window.currentProjectManifest || {};
        return String(manifest.tutorial_kind || '') === 'draft_reject' || !!manifest.draft_reject_attempt_id;
    }

    function hideDraftRejectEditorControls() {
        if (!isDraftRejectProject()) return;
        const quad = document.getElementById('btnQuadView');
        if (quad) quad.style.setProperty('display', 'none', 'important');
        document.querySelectorAll('button').forEach((btn) => {
            const text = String(btn.textContent || '').trim().toLowerCase();
            const title = String(btn.getAttribute('title') || '').trim().toLowerCase();
            const onclick = String(btn.getAttribute('onclick') || '').trim().toLowerCase();
            const shouldHide =
                text === 'save'
                || text.includes('config report')
                || text.includes('submit pdf')
                || title.includes('save project data')
                || title.includes('configure report')
                || title.includes('open quad view')
                || onclick.includes('handlesaveproject')
                || onclick.includes('handleconfigurereport')
                || onclick.includes('launchquadview');
            if (shouldHide) btn.style.setProperty('display', 'none', 'important');
        });
        document.querySelectorAll('.qa-notes-fab, .qa-notes-modal').forEach((el) => { el.style.setProperty('display', 'none', 'important'); });
    }

    function rejectionReasons() {
        const raw = Array.isArray(window.FIRSTMEASURE_REJECTION_REASONS) ? window.FIRSTMEASURE_REJECTION_REASONS : [];
        return raw.map((item) => {
            if (typeof item === 'string') return { id: item, label: item };
            return {
                id: String(item.id || item.value || item.key || item.reason || '').trim(),
                label: String(item.label || item.name || item.title || item.reason || item.id || '').trim()
            };
        }).filter((item) => item.id);
    }

    function showTutorialExplainerIfNeeded() {
        const manifest = window.currentProjectManifest || {};
        const kind = String(manifest.tutorial_kind || '');
        const isRound = kind === 'draft_reject' || !!manifest.draft_reject_attempt_id;
        const isTest = kind === 'test' || !!manifest.test_attempt_id;
        if (!isRound && !isTest) return;
        const index = Number(manifest.draft_reject_sequence_index || manifest.test_sequence_index || 1);
        if (index !== 1) return;
        const attemptId = String(manifest.draft_reject_attempt_id || manifest.test_attempt_id || '');
        const key = `fm_tutorial_explainer_${attemptId || window.currentProjectId || 'current'}`;
        if (sessionStorage.getItem(key) === '1') return;
        if (document.getElementById('tutorialExplainerModal')) return;

        const total = Number(manifest.draft_reject_sequence_total || manifest.test_sequence_total || 1);
        const title = isRound ? 'Draft or Reject' : (manifest.test_title || 'Test');
        const body = isRound
            ? `You will review ${total} project${total === 1 ? '' : 's'} in a row. Do not draw, edit, save, configure, or submit a report. Your only job is to decide whether this project is drawable with the data available, or whether it should be rejected. If you reject it, choose the rejection reason.`
            : `You are starting ${title}. You will complete ${total} project${total === 1 ? '' : 's'} in sequence. When one project is submitted, the next project opens automatically until the exam is complete.`;
        const modal = document.createElement('div');
        modal.id = 'tutorialExplainerModal';
        modal.className = 'tutorial-result-backdrop';
        modal.innerHTML = `
            <div class="tutorial-result-modal" role="dialog" aria-modal="true" aria-labelledby="tutorialExplainerTitle">
                <div class="tutorial-result-head">
                    <h2 id="tutorialExplainerTitle">${escapeHtml(title)}</h2>
                    <p>${escapeHtml(body)}</p>
                </div>
                <div class="tutorial-result-actions" style="grid-template-columns:1fr;">
                    <button type="button" class="tutorial-next" id="tutorialExplainerOk"><i class="fas fa-check"></i> I Understand</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        modal.querySelector('#tutorialExplainerOk')?.addEventListener('click', () => {
            sessionStorage.setItem(key, '1');
            modal.remove();
        });
    }

    function installDraftRejectPanel() {
        if (!isDraftRejectProject() || document.getElementById('draftRejectPanel')) return;
        ensureStyles();
        hideDraftRejectEditorControls();
        const manifest = window.currentProjectManifest || {};
        const panel = document.createElement('div');
        panel.id = 'draftRejectPanel';
        panel.style.cssText = 'position:fixed; left:20px; bottom:20px; z-index:999998; width:min(360px, calc(100vw - 40px)); background:#fff; border:1px solid #d8dde6; border-radius:12px; box-shadow:0 18px 46px rgba(16,24,40,.22); overflow:hidden;';
        const reasons = rejectionReasons();
        panel.innerHTML = `
            <div style="padding:14px 16px; background:#202124; color:#fff;">
                <div style="font-size:14px; font-weight:900;">Draft or Reject</div>
                <div style="font-size:11px; opacity:.82; margin-top:3px;">Project ${escapeHtml(manifest.draft_reject_sequence_index || 1)} of ${escapeHtml(manifest.draft_reject_sequence_total || 1)}</div>
            </div>
            <div style="padding:14px 16px;">
                <div style="font-size:12px; line-height:1.35; color:#344054; font-weight:800; margin-bottom:12px;">
                    Decide if this can be drafted from the available data. Do not draw or submit a report.
                </div>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
                    <button type="button" id="draftRejectDraftBtn" class="tutorial-stay" style="border:none; border-radius:8px; padding:12px; color:#fff; font-weight:900; cursor:pointer;">Draft</button>
                    <button type="button" id="draftRejectRejectBtn" class="tutorial-back" style="border:none; border-radius:8px; padding:12px; color:#fff; font-weight:900; cursor:pointer;">Reject</button>
                </div>
                <div id="draftRejectReasonWrap" style="display:none; margin-top:12px;">
                    <label style="display:block; font-size:11px; font-weight:900; color:#667085; margin-bottom:6px;">Rejection Reason</label>
                    <select id="draftRejectReason" style="width:100%; padding:10px; border:1px solid #d0d5dd; border-radius:8px;">
                        <option value="">Choose a reason</option>
                        ${reasons.map(r => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.label || r.id)}</option>`).join('')}
                    </select>
                </div>
                <button type="button" id="draftRejectSubmit" class="tutorial-next" disabled style="margin-top:12px; width:100%; border:none; border-radius:8px; padding:12px; color:#fff; font-weight:900; cursor:pointer; opacity:.55;">Submit Answer</button>
            </div>
        `;
        document.body.appendChild(panel);
        let decision = '';
        const submit = panel.querySelector('#draftRejectSubmit');
        const reasonWrap = panel.querySelector('#draftRejectReasonWrap');
        const reason = panel.querySelector('#draftRejectReason');
        const setDecision = (value) => {
            decision = value;
            reasonWrap.style.display = decision === 'reject' ? 'block' : 'none';
            panel.querySelector('#draftRejectDraftBtn').style.outline = decision === 'draft' ? '3px solid #8ab4f8' : 'none';
            panel.querySelector('#draftRejectRejectBtn').style.outline = decision === 'reject' ? '3px solid #f6aea9' : 'none';
            updateSubmit();
        };
        const updateSubmit = () => {
            const ok = decision === 'draft' || (decision === 'reject' && String(reason.value || '').trim());
            submit.disabled = !ok;
            submit.style.opacity = ok ? '1' : '.55';
        };
        panel.querySelector('#draftRejectDraftBtn')?.addEventListener('click', () => setDecision('draft'));
        panel.querySelector('#draftRejectRejectBtn')?.addEventListener('click', () => setDecision('reject'));
        reason?.addEventListener('change', updateSubmit);
        submit?.addEventListener('click', async () => {
            if (submit.disabled) return;
            submit.disabled = true;
            submit.textContent = 'Saving...';
            try {
                const tutorialId = ensureTutorialProjectId();
                const response = await window.firstMeasureFetchJson(`/projects/${encodeURIComponent(tutorialId)}/status`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        status: 'completed',
                        decision,
                        rejection_reason: decision === 'reject' ? String(reason.value || '') : '',
                        actor: window.FIRSTMEASURE_ACTOR || {}
                    })
                });
                const completion = response && response.completion ? response.completion : {};
                const nextUrl = completion.next_project && completion.next_project.editor_url ? completion.next_project.editor_url : '';
                if (nextUrl) window.location.href = nextUrl;
                else {
                    panel.remove();
                    showResultModal({
                        score: Number.isFinite(Number(completion.final_score)) ? Number(completion.final_score) : response.score,
                        score_details: response.score_details || null,
                        completion
                    });
                }
            } catch (err) {
                alert('Could not save this answer: ' + (err && err.message ? err.message : err));
                submit.disabled = false;
                submit.textContent = 'Submit Answer';
                updateSubmit();
            }
        });
    }

    function installTutorialTimer() {
        if (!tutorialState()) return;
        ensureStyles();
        const timer = document.getElementById('claimElapsedTimer');
        const timeline = document.getElementById('claimTimeline');
        if (timeline) {
            timeline.classList.remove('active');
            timeline.classList.add('tutorial-hidden');
        }
        if (timer) {
            timer.classList.remove('waiting', 'zone-green', 'zone-yellow', 'zone-orange', 'zone-red');
            timer.classList.add('tutorial-timer');
            timer.title = 'Tutorial elapsed time';
            timer.textContent = '00:00:00';
        }

        if (!window.firstMeasureTutorialTimerState) {
            window.firstMeasureTutorialTimerState = {
                startedAtMs: null,
                intervalId: null
            };
        }

        window.firstMeasureStartTutorialTimer = function (reset = false) {
            const state = window.firstMeasureTutorialTimerState;
            if (reset || !state.startedAtMs) {
                const manifest = window.currentProjectManifest || {};
                const startedAtMs = manifest.test_started_at ? Date.parse(manifest.test_started_at) : 0;
                state.startedAtMs = Number.isFinite(startedAtMs) && startedAtMs > 0 ? startedAtMs : Date.now();
            }
            if (!state.intervalId) {
                state.intervalId = window.setInterval(renderTutorialTimer, 500);
            }
            renderTutorialTimer();
        };

        window.firstMeasureStopClaimTimer = function () {
            const state = window.firstMeasureTutorialTimerState;
            if (state && state.intervalId) {
                window.clearInterval(state.intervalId);
                state.intervalId = null;
            }
        };

        window.firstMeasureUpdateClaimTimer = function () {
            window.firstMeasureStartTutorialTimer();
        };
    }

    function showResultModal(summary) {
        ensureStyles();
        document.getElementById('tutorialResultModal')?.remove();
        const completion = summary && typeof summary === 'object' ? (summary.completion || summary) : {};
        const isTest = completion.kind === 'test';
        const isDraftReject = completion.kind === 'draft_reject';
        const gradeHidden = summary?.grade_hidden === true || completion.grade_hidden === true;
        const nextProject = completion.next_project || null;
        const nextUrl = nextProject && nextProject.editor_url ? String(nextProject.editor_url) : '';
        const progressText = completion.label || '';
        const completeAndRedirect = isTest && completion.test_complete && completion.redirect_url;
        if (completeAndRedirect) {
            setOverlay(true, 'Submitting Test...');
            window.location.href = completion.redirect_url;
            return;
        }

        const backdrop = document.createElement('div');
        backdrop.id = 'tutorialResultModal';
        backdrop.className = 'tutorial-result-backdrop';
        const gradingDisabled = !isTest && !isDraftReject && (
            summary?.grading_enabled === false
            || summary?.score_status === 'not_graded'
            || window.currentProjectManifest?.tutorial_grading_enabled === false
        );
        const scoreText = gradingDisabled
            ? 'Complete'
            : (gradeHidden ? 'Submitted' : (summary && summary.score !== null && summary.score !== undefined && Number.isFinite(Number(summary.score)) && !isTest
            ? `${Math.round(Number(summary.score))}%`
            : (isTest ? 'Saved' : 'Saved')));
        const score = Number(summary && summary.score);
        const scoreStyle = Number.isFinite(score) && !isTest && !gradingDisabled ? ` style="color:${scoreColor(score)};"` : '';
        const scoreDetails = summary && summary.score_details && typeof summary.score_details === 'object'
            ? summary.score_details
            : null;
        backdrop.innerHTML = `
            <div class="tutorial-result-modal" role="dialog" aria-modal="true" aria-labelledby="tutorialResultTitle">
                <div class="tutorial-result-head">
                    <h2 id="tutorialResultTitle">${isDraftReject ? 'Draft or Reject Complete' : (isTest ? 'Test Project Complete' : 'Tutorial Complete')}</h2>
                    <p>${isDraftReject ? 'Your round is complete. Your score is based only on whether each project was marked Draft or Reject correctly.' : (isTest ? 'Your work was saved and this test project is locked.' : (gradingDisabled ? 'Your practice work was submitted and marked complete. Grading is disabled for this project.' : 'Your work was saved to this tutorial instance. Production project data was not changed.'))}</p>
                </div>
                <div class="tutorial-score">
                    <div class="value"${scoreStyle}>${scoreText}</div>
                    <div class="label">${gradeHidden ? 'Your score is visible to administrators only.' : (isDraftReject ? 'Final round score' : (isTest ? 'Your test score is visible to administrators only.' : (gradingDisabled ? 'Practice submitted — no score calculated' : 'Score by category')))}</div>
                </div>
                ${(!isTest && !isDraftReject && !gradingDisabled) ? renderScoreBreakdown(scoreDetails) : ''}
                ${progressText ? `<div class="tutorial-progress-note">${progressText}</div>` : ''}
                <div class="tutorial-result-actions">
                    <button type="button" class="tutorial-back" id="tutorialBackToLessons"><i class="fas fa-arrow-left"></i> Tutorials</button>
                    <button type="button" class="tutorial-stay" id="tutorialStayHere" ${isTest || isDraftReject ? 'hidden' : ''}><i class="fas fa-pencil-ruler"></i> Keep Editing</button>
                    <button type="button" class="tutorial-next" id="tutorialNextProject" ${nextUrl ? '' : 'hidden'}><i class="fas fa-arrow-right"></i> Next</button>
                </div>
            </div>
        `;
        document.body.appendChild(backdrop);
        backdrop.querySelector('#tutorialBackToLessons')?.addEventListener('click', () => {
            window.location.href = './?view=tutorials';
        });
        backdrop.querySelector('#tutorialStayHere')?.addEventListener('click', () => {
            backdrop.remove();
        });
        backdrop.querySelector('#tutorialNextProject')?.addEventListener('click', () => {
            if (nextUrl) window.location.href = nextUrl;
        });
    }

    async function saveTutorialXml(state) {
        if (typeof generateRoofXML !== 'function') return;
        const xmlString = generateRoofXML(state);
        if (!xmlString) return;
        const xmlBlob = new Blob([xmlString], { type: 'text/xml' });
        await window.firstMeasureUploadArtifact(state.folderId, xmlBlob, 'model_data.xml');
    }

    async function submitTutorialProject() {
        const btn = document.querySelector('#finalSubmitBtn');
        const tutorialId = ensureTutorialProjectId();

        if (btn) {
            btn.innerText = 'Completing...';
            btn.disabled = true;
            btn.className = 'fin-submit-btn disabled';
        }

        try {
            setOverlay(true, 'Saving Tutorial Work...');
            if (typeof window.saveProjectData === 'function') {
                const saved = await window.saveProjectData(true, true);
                if (!saved) throw new Error('Tutorial save failed.');
            }

            let state = window.reportConfigState || null;
            if (!state && typeof captureStateForPDF === 'function') {
                state = await captureStateForPDF();
            }
            if (state && !state.folderId) state.folderId = tutorialId;
            if (!state) state = { folderId: tutorialId };

            if (typeof window.updateStateImages === 'function' && window.reportConfigState) {
                setOverlay(true, 'Refreshing Tutorial Snapshot...');
                await window.updateStateImages(state);
            }

            if (typeof window.saveStandalonePdfState === 'function') {
                const snapshotSaved = await window.saveStandalonePdfState(state, { refreshImages: false });
                if (!snapshotSaved) {
                    throw new Error('The tutorial grading snapshot could not be created. Reopen Config and try submitting again.');
                }
            }

            setOverlay(true, 'Saving Tutorial Model...');
            await saveTutorialXml(state);

            setOverlay(true, 'Marking Tutorial Complete...');
            const completionResponse = await window.firstMeasureFetchJson(`/projects/${encodeURIComponent(tutorialId)}/status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    status: 'completed',
                    actor: window.FIRSTMEASURE_ACTOR || {}
                })
            });

            if (window.currentProjectManifest) {
                window.currentProjectManifest.status = 'tutorial_completed';
                window.currentProjectManifest.completed_at = new Date().toISOString();
                const completion = completionResponse && completionResponse.completion ? completionResponse.completion : null;
                if (completion && completion.kind === 'test') {
                    window.currentProjectManifest.test_completed_count = completion.completed || window.currentProjectManifest.test_completed_count || 0;
                    window.currentProjectManifest.test_project_count = completion.total || window.currentProjectManifest.test_project_count || 0;
                    renderTutorialTimer();
                }
            }

            setOverlay(false);
            if (typeof closeReportConfig === 'function') closeReportConfig();
            showResultModal(completionResponse || { score: null });
        } catch (err) {
            console.error('[Tutorial] Submit failed:', err);
            setOverlay(false);
            alert('Tutorial submission failed: ' + (err && err.message ? err.message : err));
            if (btn) {
                btn.innerHTML = '<i class="fas fa-file-pdf"></i> Submit PDF';
                btn.disabled = false;
                btn.className = 'fin-submit-btn enabled';
            }
        }
    }

    function installTutorialSubmissionWrapper() {
        if (!tutorialState()) return;
        window.firstMeasureSubmitProject = submitTutorialProject;
        window.submitFinalReport = function () {
            return window.firstMeasureSubmitProject.apply(this, arguments);
        };
        window.quickSubmitReport = function () {
            return window.firstMeasureSubmitProject.apply(this, arguments);
        };
    }

    window.firstMeasureIsTutorialProjectId = isTutorialProjectId;
    window.firstMeasureSubmitTutorialProject = submitTutorialProject;

    window.addEventListener('load', () => {
        if (!tutorialState()) return;
        showRibbon();
        installTutorialTimer();
        installTutorialSubmissionWrapper();
        setTimeout(() => {
            hideDraftRejectEditorControls();
            installDraftRejectPanel();
            showTutorialExplainerIfNeeded();
        }, 500);
        setTimeout(installTutorialSubmissionWrapper, 250);
        setTimeout(() => {
            installTutorialSubmissionWrapper();
            hideDraftRejectEditorControls();
            installDraftRejectPanel();
            showTutorialExplainerIfNeeded();
        }, 1000);
        let tries = 0;
        const draftRejectPoll = window.setInterval(() => {
            tries++;
            hideDraftRejectEditorControls();
            installDraftRejectPanel();
            showTutorialExplainerIfNeeded();
            if (tries >= 20 || document.getElementById('draftRejectPanel')) window.clearInterval(draftRejectPoll);
        }, 500);
    });
})();
