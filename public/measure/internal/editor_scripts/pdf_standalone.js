(function () {
    const DEFAULT_API_BODY_LIMIT_BYTES = 900 * 1024;
    const PDF_SYNC_SINGLE_REQUEST_MAX_BYTES = 20 * 1024 * 1024;
    const PDF_SYNC_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
    const PDF_SYNC_UPLOAD_CONCURRENCY = 3;
    const PDF_RENDER_RECIPE_VERSION = '2026-08-16.1';
    let isolatedPdfRuntimePromise = null;

    function ensurePdfRuntimeAvailable() {
        if (typeof window.generatePDFFromState !== 'function') {
            throw new Error('pdf.js must be loaded before pdf_standalone.js');
        }
        if (!window.jspdf || !window.jspdf.jsPDF) {
            throw new Error('jsPDF is required before running the standalone PDF runtime');
        }
    }

    function cloneJson(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function findLoadedScriptUrl(fragment) {
        const scripts = Array.from(document.querySelectorAll('script[src]'));
        const match = scripts.find((script) => String(script.src || '').includes(fragment));
        return match ? match.src : '';
    }

    function loadRuntimeScript(doc, src) {
        return new Promise((resolve, reject) => {
            const script = doc.createElement('script');
            script.src = src;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error(`Failed to load isolated PDF runtime script: ${src}`));
            doc.head.appendChild(script);
        });
    }

    function getIsolatedPdfRuntime() {
        if (isolatedPdfRuntimePromise) return isolatedPdfRuntimePromise;
        isolatedPdfRuntimePromise = new Promise((resolve, reject) => {
            const frame = document.createElement('iframe');
            frame.hidden = true;
            frame.setAttribute('aria-hidden', 'true');
            frame.setAttribute('data-firstmeasure-pdf-runtime', 'isolated');
            frame.src = '/v1/firstmeasure/pdf-runtime/blank';
            frame.onload = async () => {
                try {
                    const runtimeWindow = frame.contentWindow;
                    const runtimeDocument = frame.contentDocument;
                    if (!runtimeWindow || !runtimeDocument) {
                        throw new Error('The isolated PDF runtime frame is unavailable.');
                    }
                    runtimeWindow.__pdfAssetBaseUrl = '/v1/firstmeasure/pdf-runtime';
                    const jsPdfUrl = findLoadedScriptUrl('/pdf-runtime/assets/jspdf');
                    const pdfUrl = findLoadedScriptUrl('/editor_scripts/pdf.js');
                    const standaloneUrl = findLoadedScriptUrl('/editor_scripts/pdf_standalone.js');
                    if (!jsPdfUrl || !pdfUrl || !standaloneUrl) {
                        throw new Error('The shared PDF runtime script URLs could not be resolved.');
                    }
                    await loadRuntimeScript(runtimeDocument, jsPdfUrl);
                    await loadRuntimeScript(runtimeDocument, pdfUrl);
                    await loadRuntimeScript(runtimeDocument, standaloneUrl);
                    if (!runtimeWindow.FirstMatePDFStandalone) {
                        throw new Error('The isolated PDF runtime did not initialize.');
                    }
                    resolve(runtimeWindow);
                } catch (error) {
                    frame.remove();
                    isolatedPdfRuntimePromise = null;
                    reject(error);
                }
            };
            frame.onerror = () => {
                frame.remove();
                isolatedPdfRuntimePromise = null;
                reject(new Error('Failed to load the isolated PDF runtime frame.'));
            };
            document.body.appendChild(frame);
        });
        return isolatedPdfRuntimePromise;
    }

    function createPdfSyncRevision() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
        return `pdf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    }

    function preparePdfSyncSnapshot(snapshot, options = {}) {
        const prepared = cloneJson(snapshot || {});
        prepared.pdfSyncRevision = options.revision || createPdfSyncRevision();
        prepared.pdfRenderDateLabel = options.dateLabel || new Date().toLocaleDateString('en-US');
        prepared.savedAt = options.savedAt || new Date().toISOString();
        prepared.pdfGeneratedAt = options.generatedAt || prepared.savedAt;
        const runtimeContext = (options.runtimeContext && typeof options.runtimeContext === 'object')
            ? options.runtimeContext
            : {};
        const manifest = (runtimeContext.manifest && typeof runtimeContext.manifest === 'object')
            ? runtimeContext.manifest
            : {};
        prepared.pdfRenderContext = {
            manifest: {
                project_type: manifest.project_type || null,
                radius_meters: manifest.radius_meters ?? null,
                include_gutter_measurements: manifest.include_gutter_measurements ?? null,
                gutter_profile: manifest.gutter_profile || null
            },
            organization: (runtimeContext.organization && typeof runtimeContext.organization === 'object')
                ? cloneJson(runtimeContext.organization)
                : null
        };
        return prepared;
    }

    async function sha256Blob(blob) {
        const bytes = await blob.arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, '0')).join('');
    }

    function canonicalizeForChecksum(value) {
        if (Array.isArray(value)) return value.map(canonicalizeForChecksum);
        if (!value || typeof value !== 'object') return value;
        const output = {};
        for (const key of Object.keys(value).sort()) {
            const item = value[key];
            if (item === undefined || typeof item === 'function') continue;
            output[key] = canonicalizeForChecksum(item);
        }
        return output;
    }

    async function sha256Json(value) {
        const canonicalJson = JSON.stringify(canonicalizeForChecksum(value));
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson));
        return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
    }

    function buildPdfRenderRecipe(state, options = {}) {
        const mode = options.mode || 'full';
        return {
            version: PDF_RENDER_RECIPE_VERSION,
            state,
            output: {
                mode,
                applyBrandingToFull: !!options.applyBrandingToFull,
                pageConfigOverride: options.pageConfigOverride || {},
                coverTitle: options.coverTitle || (mode === 'summary' ? 'Roof Summary' : 'Project Overview')
            }
        };
    }

    function normalizePdfRenderContractOutput(spec = {}) {
        const mode = spec.mode === 'summary' ? 'summary' : 'full';
        return {
            slot: spec.slot || (mode === 'summary' ? 'summary' : 'main'),
            mode,
            applyBrandingToFull: !!(spec.applyBrandingToFull ?? spec.apply_branding_to_full),
            disableOrganizationBranding: !!(spec.disableOrganizationBranding ?? spec.disable_organization_branding),
            useProjectOrganizationBranding: !!(spec.useProjectOrganizationBranding ?? spec.use_project_organization_branding),
            clearBrandingOverrides: !!(spec.clearBrandingOverrides ?? spec.clear_branding_overrides),
            pageConfigOverride: spec.pageConfigOverride || spec.page_config || {},
            brandingOverrides: spec.brandingOverrides || spec.branding_overrides || {},
            statePatch: spec.statePatch || spec.snapshot_patch || {},
            pdfConfigPatch: spec.pdfConfigPatch || spec.pdf_config_patch || {},
            coverTitle: spec.coverTitle || spec.cover_title || (mode === 'summary' ? 'Roof Summary' : 'Project Overview')
        };
    }

    async function buildPdfRenderContractChecksums(snapshot, outputs) {
        const checksums = {};
        for (const spec of outputs) {
            const normalized = normalizePdfRenderContractOutput(spec);
            checksums[normalized.slot] = await sha256Json({
                version: PDF_RENDER_RECIPE_VERSION,
                snapshot,
                output: normalized
            });
        }
        return checksums;
    }

    function mergeObjects(baseValue, patchValue) {
        const base = (baseValue && typeof baseValue === 'object') ? cloneJson(baseValue) : {};
        const patch = (patchValue && typeof patchValue === 'object') ? cloneJson(patchValue) : {};
        return { ...base, ...patch };
    }

    function isBrandingVariant(value) {
        return !!(value && typeof value === 'object' && (
            typeof value.logo_node_url === 'string' ||
            typeof value.logo_url === 'string' ||
            typeof value.logo === 'string' ||
            typeof value.logoDataUrl === 'string' ||
            typeof value.logo_data_url === 'string' ||
            typeof value.primary_color === 'string' ||
            typeof value.secondary_color === 'string' ||
            value.colors
        ));
    }

    function firstLogoValue(...sources) {
        for (const source of sources) {
            const record = (source && typeof source === 'object') ? source : {};
            const nestedBranding = (record.branding && typeof record.branding === 'object') ? record.branding : null;
            const candidates = [
                record.logo,
                record.logo_node_url,
                record.logo_url,
                record.logoDataUrl,
                record.logo_data_url,
                nestedBranding && nestedBranding.logo,
                nestedBranding && nestedBranding.logo_node_url,
                nestedBranding && nestedBranding.logo_url,
                nestedBranding && nestedBranding.logoDataUrl,
                nestedBranding && nestedBranding.logo_data_url
            ];
            for (const candidate of candidates) {
                const logo = String(candidate || '').trim();
                if (logo) return logo;
            }
        }
        return '';
    }

    function extractBrandingVariant(source, mode) {
        const direct = (source && typeof source === 'object') ? source : {};
        if (direct.branding && direct.branding.logo && direct.branding.colors) return direct.branding;
        if (isBrandingVariant(direct) && !direct.full && !direct.summary && !direct.branding) return direct;
        const packet = (direct.branding && typeof direct.branding === 'object') ? direct.branding : direct;
        const keys = mode === 'summary'
            ? ['summary', 'customer', 'default', 'report', 'full']
            : ['full', 'report', 'default', 'summary'];
        for (const key of keys) {
            if (isBrandingVariant(packet[key])) return packet[key];
        }
        return isBrandingVariant(packet) ? packet : {};
    }

    function normalizeBrandingForPdf(organization, mode) {
        const org = (organization && typeof organization === 'object') ? cloneJson(organization) : {};
        const variant = extractBrandingVariant(org, mode);
        const colors = (variant.colors && typeof variant.colors === 'object') ? variant.colors : {};
        const logo = firstLogoValue(variant, org.branding, org);
        const primary = colors.primary || variant.primary_color || '';
        const secondary = colors.secondary || variant.secondary_color || '';
        if (!logo && !primary && !secondary && !firstLogoValue(org.branding, org)) return org;
        return {
            ...org,
            branding: {
                ...(org.branding && typeof org.branding === 'object' ? org.branding : {}),
                ...(logo ? { logo, logo_url: logo, logo_node_url: logo } : {}),
                colors: {
                    ...((org.branding && org.branding.colors && typeof org.branding.colors === 'object') ? org.branding.colors : {}),
                    ...(primary ? { primary } : {}),
                    ...(secondary ? { secondary } : {})
                }
            }
        };
    }

    function applyStatePatches(state, options = {}) {
        let nextState = cloneJson(state);
        if (options.statePatch && typeof options.statePatch === 'object') {
            nextState = mergeObjects(nextState, options.statePatch);
        }
        if (options.pdfConfigPatch && typeof options.pdfConfigPatch === 'object') {
            nextState.pdfConfig = mergeObjects(nextState.pdfConfig, options.pdfConfigPatch);
        }
        if (options.brandingOverrides && typeof options.brandingOverrides === 'object') {
            nextState.brandingOverrides = mergeObjects(nextState.brandingOverrides, options.brandingOverrides);
        }
        if (options.outputFileName) {
            nextState.outputFileName = String(options.outputFileName);
        }
        return nextState;
    }

    async function fetchJson(url, init) {
        const resp = await fetch(url, init);
        if (!resp.ok) {
            throw new Error(`Request failed (${resp.status}) for ${url}`);
        }
        return resp.json();
    }

    function hydrateStandaloneContext(snapshot, runtimeContext = {}, options = {}) {
        const state = cloneJson(snapshot);
        const frozenContext = (state.pdfRenderContext && typeof state.pdfRenderContext === 'object')
            ? state.pdfRenderContext
            : {};
        const manifestSource = frozenContext.manifest || runtimeContext.manifest;
        const organizationSource = frozenContext.organization || runtimeContext.organization;
        const manifest = manifestSource ? cloneJson(manifestSource) : null;
        let organization = organizationSource ? cloneJson(organizationSource) : null;
        const folderId = runtimeContext.folderId || state.folderId || null;

        if (options.disableOrganizationBranding === true && organization && typeof organization === 'object') {
            organization = { ...organization };
            delete organization.branding;
            runtimeContext = { ...runtimeContext, organization };
        }

        if (options.useProjectOrganizationBranding === true) {
            if (!organization || !organization.branding) {
                console.warn('Company branding was requested, but no organization branding was loaded. Falling back to default report branding.');
            } else {
                delete state.brandingOverrides;
            }
        }

        if (options.organizationBranding) {
            const nextOrg = organization || {};
            nextOrg.branding = cloneJson(options.organizationBranding);
            runtimeContext = { ...runtimeContext, organization: nextOrg };
        }

        if (options.clearBrandingOverrides) {
            delete state.brandingOverrides;
        } else if (options.brandingOverrides && typeof options.brandingOverrides === 'object') {
            state.brandingOverrides = mergeObjects(state.brandingOverrides, options.brandingOverrides);
        }

        if (options.applyBrandingToFull !== undefined) {
            state.applyBrandingToFull = !!options.applyBrandingToFull;
        }

        const finalOrganization = normalizeBrandingForPdf(
            (runtimeContext.organization && typeof runtimeContext.organization === 'object')
                ? runtimeContext.organization
                : organization,
            options.mode || 'full'
        );

        window.currentProjectId = folderId;
        window.currentProjectManifest = manifest;
        window.projectOrganization = finalOrganization;
        window.reportExcludedSignatures = new Set(state.excludedSignatures || []);

        return state;
    }

    async function loadProjectBundle(folderId, options = {}) {
        const localEndpoint = !options.endpoint && typeof window.firstMeasureBuildEditorBundleUrl === 'function'
            ? window.firstMeasureBuildEditorBundleUrl(folderId)
            : null;
        const remoteEndpoint = options.endpoint || (
            typeof window.firstMeasureBuildUrl === 'function'
                ? window.firstMeasureBuildUrl(`/projects/${encodeURIComponent(folderId)}/editor`)
                : `/v1/firstmeasure/projects/${encodeURIComponent(folderId)}/editor`
        );

        let data = null;
        let resolvedEndpoint = remoteEndpoint;

        if (localEndpoint) {
            try {
                data = await fetchJson(localEndpoint, {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' }
                });
                resolvedEndpoint = localEndpoint;
            } catch (localError) {
                console.warn('[PDF Local Bundle] Failed to load local editor bundle; falling back to remote project editor endpoint.', localError);
            }
        }

        if (!data) {
            data = await fetchJson(remoteEndpoint, {
                method: 'GET',
                headers: { 'Accept': 'application/json' }
            });
        }
        if (!data || !data.pdf_state_asset) {
            throw new Error(`No saved pdf_state.json found for project ${folderId}`);
        }

        const cacheBust = `t=${Date.now()}`;
        const separator = data.pdf_state_asset.includes('?') ? '&' : '?';
        const snapshot = await fetchJson(`${data.pdf_state_asset}${separator}${cacheBust}`);

        return {
            folderId,
            manifest: data.manifest || null,
            organization: data.organization || null,
            appMetadata: data.app_metadata || null,
            pdfStateAsset: data.pdf_state_asset,
            snapshot,
            sourceEndpoint: resolvedEndpoint
        };
    }

    async function generateProjectPdfFromSnapshot(snapshot, runtimeContext = {}, options = {}) {
        ensurePdfRuntimeAvailable();

        const mode = options.mode || 'full';
        const hydratedState = hydrateStandaloneContext(snapshot, runtimeContext, options);
        const state = applyStatePatches(hydratedState, options);
        const renderChecksum = await sha256Json(buildPdfRenderRecipe(state, { ...options, mode }));
        const result = await window.generatePDFFromState(
            state,
            mode,
            options.onStatus || null,
            {
                skipUpload: options.skipUpload !== undefined ? !!options.skipUpload : true,
                skipStatusUpdate: options.skipStatusUpdate !== undefined ? !!options.skipStatusUpdate : true,
                applyBrandingToFull: options.applyBrandingToFull !== undefined ? !!options.applyBrandingToFull : undefined,
                pageConfigOverride: (options.pageConfigOverride && typeof options.pageConfigOverride === 'object') ? options.pageConfigOverride : undefined,
                outputFileName: options.outputFileName || undefined,
                coverTitle: options.coverTitle || undefined
            }
        );

        if (options.download && typeof window.triggerBlobDownload === 'function') {
            await window.triggerBlobDownload(result.blob, result.filename);
        }

        return { state, result, renderChecksum };
    }

    async function generateProjectPdfsFromSnapshot(snapshot, runtimeContext = {}, options = {}) {
        const results = [];
        const outputs = Array.isArray(options.outputs) && options.outputs.length
            ? options.outputs
            : (Array.isArray(options.modes) && options.modes.length
                ? options.modes.map((mode) => ({ mode }))
                : [{ mode: 'full' }, { mode: 'summary' }]);

        for (const output of outputs) {
            const spec = (output && typeof output === 'object') ? output : { mode: output };
            const mode = spec.mode || 'full';
            const modeStatus = typeof options.onStatus === 'function'
                ? (msg) => options.onStatus({ mode, message: msg })
                : null;

            const generated = await generateProjectPdfFromSnapshot(
                snapshot,
                runtimeContext,
                {
                    ...options,
                    ...spec,
                    mode,
                    onStatus: modeStatus
                }
            );
            const completed = { ...spec, mode, ...generated };
            results.push(completed);
            if (typeof options.onOutput === 'function') await options.onOutput(completed);
        }

        return results;
    }

    async function generateProjectPdfFromFolder(folderId, options = {}) {
        const bundle = await loadProjectBundle(folderId, options);
        return generateProjectPdfFromSnapshot(
            bundle.snapshot,
            {
                folderId: bundle.folderId,
                manifest: bundle.manifest,
                organization: bundle.organization
            },
            options
        );
    }

    async function generateProjectPdfsFromFolder(folderId, options = {}) {
        const bundle = await loadProjectBundle(folderId, options);
        return generateProjectPdfsFromSnapshot(
            bundle.snapshot,
            {
                folderId: bundle.folderId,
                manifest: bundle.manifest,
                organization: bundle.organization
            },
            options
        );
    }

    function buildDefaultOutputSpecs(options = {}) {
        const applyBrandingToFull = options.applyBrandingToFull !== undefined
            ? !!options.applyBrandingToFull
            : true;
        return Array.isArray(options.outputs) && options.outputs.length
            ? options.outputs
            : [
                {
                    slot: 'main',
                    mode: 'full',
                    persist: true,
                    update_status: options.updateStatus !== undefined ? !!options.updateStatus : true,
                    apply_branding_to_full: applyBrandingToFull
                },
                {
                    slot: 'summary',
                    mode: 'summary',
                    persist: true,
                    update_status: false
                }
            ];
    }

    function buildProjectPdfsApiEndpoint(folderId, options = {}) {
        const endpoint = options.endpoint || (
            typeof window.firstMeasureBuildUrl === 'function'
                ? window.firstMeasureBuildUrl(`/projects/${encodeURIComponent(folderId)}/pdfs/generate`)
                : `/v1/firstmeasure/projects/${encodeURIComponent(folderId)}/pdfs/generate`
        );
        if (!options.debug) return endpoint;
        try {
            const url = new URL(endpoint, window.location.origin);
            url.searchParams.set('debug', '1');
            url.searchParams.set('debug_source', 'qa_editor_submit');
            return url.toString();
        } catch (e) {
            const joiner = String(endpoint).includes('?') ? '&' : '?';
            return `${endpoint}${joiner}debug=1&debug_source=qa_editor_submit`;
        }
    }

    function buildProjectPdfsApiPayload(snapshot, options = {}) {
        return {
            source: 'inline',
            snapshot,
            persist_files: options.persistFiles !== undefined ? !!options.persistFiles : true,
            update_status: options.updateStatus !== undefined ? !!options.updateStatus : true,
            outputs: buildDefaultOutputSpecs(options)
        };
    }

    function getStringByteLength(value) {
        const text = typeof value === 'string' ? value : String(value || '');
        if (typeof TextEncoder !== 'undefined') {
            return new TextEncoder().encode(text).length;
        }
        return unescape(encodeURIComponent(text)).length;
    }

    function createPdfSyncUploadId() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
            return `pdf-${window.crypto.randomUUID()}`;
        }
        return `pdf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    }

    function bytesToBase64(bytes) {
        let binary = '';
        const blockSize = 0x8000;
        for (let offset = 0; offset < bytes.length; offset += blockSize) {
            const block = bytes.subarray(offset, Math.min(offset + blockSize, bytes.length));
            binary += String.fromCharCode.apply(null, block);
        }
        return btoa(binary);
    }

    async function sha256Bytes(bytes) {
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, '0')).join('');
    }

    async function fetchPdfSyncJson(endpoint, options, fallbackMessage) {
        const response = await fetch(endpoint, options);
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok === false) {
            const error = new Error(data.message || data.error || fallbackMessage || `PDF sync request failed (${response.status}).`);
            error.status = response.status;
            error.endpoint = endpoint;
            error.details = data;
            throw error;
        }
        return data;
    }

    async function enqueueChunkedProjectPdfSync(syncEndpoint, payloadBytes, options = {}) {
        const uploadId = createPdfSyncUploadId();
        const uploadEndpoint = `${syncEndpoint}/uploads`;
        const chunkCount = Math.ceil(payloadBytes.length / PDF_SYNC_UPLOAD_CHUNK_BYTES);
        const payloadSha256 = await sha256Bytes(payloadBytes);
        if (typeof options.onStatus === 'function') {
            options.onStatus({ message: `Uploading PDF snapshot in ${chunkCount} parts...` });
        }
        await fetchPdfSyncJson(uploadEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({
                upload_id: uploadId,
                chunk_count: chunkCount,
                payload_bytes: payloadBytes.length,
                payload_sha256: payloadSha256
            })
        }, 'Failed to initialize the multipart PDF sync upload.');

        let nextChunkIndex = 0;
        const uploadWorker = async () => {
            while (nextChunkIndex < chunkCount) {
                const chunkIndex = nextChunkIndex++;
                const start = chunkIndex * PDF_SYNC_UPLOAD_CHUNK_BYTES;
                const chunk = payloadBytes.subarray(start, Math.min(start + PDF_SYNC_UPLOAD_CHUNK_BYTES, payloadBytes.length));
                await fetchPdfSyncJson(`${uploadEndpoint}/${encodeURIComponent(uploadId)}/chunks/${chunkIndex}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    body: JSON.stringify({ chunk_base64: bytesToBase64(chunk) })
                }, `Failed to upload PDF sync part ${chunkIndex + 1} of ${chunkCount}.`);
            }
        };
        await Promise.all(Array.from(
            { length: Math.min(PDF_SYNC_UPLOAD_CONCURRENCY, chunkCount) },
            () => uploadWorker()
        ));
        if (typeof options.onStatus === 'function') {
            options.onStatus({ message: 'Assembling PDF snapshot on the server...' });
        }
        return fetchPdfSyncJson(`${uploadEndpoint}/${encodeURIComponent(uploadId)}/complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: '{}'
        }, 'Failed to assemble the multipart PDF sync upload.');
    }

    function summarizeSnapshotPayloadFields(snapshot) {
        if (!snapshot || typeof snapshot !== 'object') return [];

        const fieldSizes = [];
        const addFieldSize = (field, value) => {
            if (typeof value !== 'string' || value.length < 1) return;
            fieldSizes.push({
                field,
                bytes: getStringByteLength(value)
            });
        };

        addFieldSize('solarImg', snapshot.solarImg);
        addFieldSize('ventImg', snapshot.ventImg);
        addFieldSize('quadImage', snapshot.quadImage);
        addFieldSize('brandingOverrides.logoDataUrl', snapshot?.brandingOverrides?.logoDataUrl);

        if (Array.isArray(snapshot.wireframes)) {
            snapshot.wireframes.forEach((item, index) => {
                addFieldSize(`wireframes[${index}].img`, item && item.img);
            });
        }

        return fieldSizes
            .sort((a, b) => b.bytes - a.bytes)
            .slice(0, 8);
    }

    function estimateProjectPdfsApiPayload(folderId, snapshot, options = {}) {
        if (!folderId) throw new Error('A project id is required for API PDF generation.');
        if (!snapshot || typeof snapshot !== 'object') throw new Error('A PDF snapshot is required for API PDF generation.');

        const payload = buildProjectPdfsApiPayload(snapshot, options);
        const bodyBytes = getStringByteLength(JSON.stringify(payload));
        const maxBodyBytes = Number.isFinite(Number(options.maxBodyBytes))
            ? Number(options.maxBodyBytes)
            : DEFAULT_API_BODY_LIMIT_BYTES;

        return {
            endpoint: buildProjectPdfsApiEndpoint(folderId, options),
            bodyBytes,
            maxBodyBytes,
            withinLimit: bodyBytes <= maxBodyBytes,
            snapshotSummary: {
                folderId: snapshot.folderId || folderId || null,
                faces: Array.isArray(snapshot.facesData) ? snapshot.facesData.length : 0,
                structures: Array.isArray(snapshot.structures) ? snapshot.structures.length : 0,
                wireframes: Array.isArray(snapshot.wireframes) ? snapshot.wireframes.length : 0,
                largestFields: summarizeSnapshotPayloadFields(snapshot)
            }
        };
    }

    function normalizeLocalOutputSpecs(options = {}) {
        return buildDefaultOutputSpecs(options).map((spec) => {
            const normalized = (spec && typeof spec === 'object') ? { ...spec } : { mode: spec };
            if (!normalized.mode) normalized.mode = 'full';
            if (!normalized.slot) normalized.slot = normalized.mode === 'summary' ? 'summary' : 'main';
            if (normalized.persist === undefined && normalized.persist_files !== undefined) {
                normalized.persist = !!normalized.persist_files;
            }
            if (normalized.update_status === undefined && normalized.updateStatus !== undefined) {
                normalized.update_status = !!normalized.updateStatus;
            }
            if (normalized.applyBrandingToFull === undefined && normalized.apply_branding_to_full !== undefined) {
                normalized.applyBrandingToFull = !!normalized.apply_branding_to_full;
            }
            if (!normalized.outputFileName && normalized.file_name) {
                normalized.outputFileName = normalized.file_name;
            }
            if (!normalized.coverTitle && normalized.cover_title) {
                normalized.coverTitle = normalized.cover_title;
            }
            if (!normalized.pageConfigOverride && normalized.page_config && typeof normalized.page_config === 'object') {
                normalized.pageConfigOverride = normalized.page_config;
            }
            return normalized;
        });
    }

    async function generateProjectPdfsLocally(snapshot, runtimeContext = {}, options = {}) {
        const normalizedOutputs = normalizeLocalOutputSpecs(options);
        const runtimeWindow = await getIsolatedPdfRuntime();
        const generated = [];

        for (const spec of normalizedOutputs) {
            const mode = spec.mode || 'full';
            const modeStatus = typeof options.onStatus === 'function'
                ? (message) => options.onStatus({ mode, message })
                : null;
            const persistOutput = spec.persist !== false;
            const updateStatus = !!spec.update_status;

            const item = await runtimeWindow.FirstMatePDFStandalone.generateProjectPdfFromSnapshot(
                snapshot,
                runtimeContext,
                {
                    ...options,
                    ...spec,
                    mode,
                    onStatus: modeStatus,
                    skipUpload: !persistOutput,
                    skipStatusUpdate: !updateStatus
                }
            );
            generated.push({ ...spec, mode, ...item });
        }

        return {
            ok: true,
            source: 'local-shared-runtime',
            outputs: generated.map((item, index) => {
                const spec = normalizedOutputs[index] || {};
                const result = item && item.result ? item.result : {};
                return {
                    slot: spec.slot || (item.mode === 'summary' ? 'summary' : 'main'),
                    mode: item.mode || spec.mode || 'full',
                    file_name: result.filename || spec.file_name || spec.outputFileName || 'report.pdf',
                    blob: result.blob || null,
                    render_checksum: item.renderChecksum || null,
                    persist: spec.persist !== false,
                    update_status: !!spec.update_status
                };
            })
        };
    }

    async function generateProjectPdfsViaApi(folderId, snapshot, options = {}) {
        if (!folderId) throw new Error('A project id is required for API PDF generation.');
        if (!snapshot || typeof snapshot !== 'object') throw new Error('A PDF snapshot is required for API PDF generation.');

        const endpoint = buildProjectPdfsApiEndpoint(folderId, options);
        const payload = buildProjectPdfsApiPayload(snapshot, options);
        const payloadEstimate = estimateProjectPdfsApiPayload(folderId, snapshot, options);
        if (!payloadEstimate.withinLimit) {
            const error = new Error('The PDF API payload is too large for inline submission.');
            error.code = 'CLIENT_PDF_API_BODY_TOO_LARGE_PRECHECK';
            error.status = 413;
            error.endpoint = endpoint;
            error.details = {
                error: 'FST_ERR_CTP_BODY_TOO_LARGE',
                message: 'Skipped API PDF generation because the inline snapshot payload exceeds the safe request size.',
                body_bytes: payloadEstimate.bodyBytes,
                max_body_bytes: payloadEstimate.maxBodyBytes,
                snapshot_summary: payloadEstimate.snapshotSummary
            };
            throw error;
        }

        const fetchOptions = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify(payload)
        };
        let resp;
        try {
            resp = await fetch(endpoint, fetchOptions);
        } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e || 'Fetch failed'));
            error.endpoint = endpoint;
            error.details = {
                likely_cors_or_network_error: true,
                origin: window.location.origin,
                request: {
                    method: fetchOptions.method,
                    headers: fetchOptions.headers,
                    body_length: fetchOptions.body.length,
                    body_preview: fetchOptions.body.slice(0, 1200)
                },
                debug: !!options.debug,
                note: 'If this is a CORS preflight failure, check Access-Control-Allow-Headers on the API response. Debug metadata is sent via debug_source query params to avoid custom request headers.'
            };
            console.group('[PDF API GENERATE NETWORK ERROR]');
            console.error(error);
            console.log('endpoint:', endpoint);
            console.log('details:', error.details);
            console.groupEnd();
            throw error;
        }
        const responseText = await resp.text();
        let data = null;
        try { data = responseText ? JSON.parse(responseText) : null; } catch (e) {}
        if (!data) data = { ok: resp.ok };
        if (!resp.ok || data.ok === false) {
            const debugMessage = data.debug_error && (data.debug_error.message || data.debug_error.name)
                ? `${data.debug_error.name || 'server_error'}: ${data.debug_error.message || ''}`.trim()
                : '';
            const error = new Error(debugMessage || data.message || data.error || 'API PDF generation failed.');
            error.status = resp.status;
            error.endpoint = endpoint;
            error.details = data;
            error.responseText = responseText;
            error.debugTrace = resp.headers.get('X-FirstMeasure-Debug-Trace') || '';
            throw error;
        }

        if (options.download && typeof window.triggerBlobDownload === 'function') {
            for (const output of (data.outputs || [])) {
                if (!output || !output.pdf_url) continue;
                const fileResp = await fetch(output.pdf_url, { headers: { 'Accept': 'application/pdf' } });
                if (!fileResp.ok) continue;
                const blob = await fileResp.blob();
                await window.triggerBlobDownload(blob, output.file_name || 'report.pdf');
            }
        }

        return data;
    }

    function buildProjectPdfSyncEndpoint(folderId) {
        return typeof window.firstMeasureBuildUrl === 'function'
            ? window.firstMeasureBuildUrl(`/projects/${encodeURIComponent(folderId)}/pdfs/sync`)
            : `/v1/firstmeasure/projects/${encodeURIComponent(folderId)}/pdfs/sync`;
    }

    async function monitorProjectPdfSync(folderId, accepted, localChecksums, localRenderChecksums, options = {}) {
        const jobId = accepted && accepted.job_id;
        if (!jobId) return null;
        const endpoint = `${buildProjectPdfSyncEndpoint(folderId)}/${encodeURIComponent(jobId)}`;
        const deadline = Date.now() + (Number(options.syncTimeoutMs) || 300000);
        while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 750));
            const response = await fetch(endpoint, { headers: { 'Accept': 'application/json' }, cache: 'no-store' });
            if (!response.ok) continue;
            const data = await response.json().catch(() => ({}));
            const job = data && data.job ? data.job : {};
            if (job.status === 'failed') {
                console.error('[PDF SYNC] Server render failed.', { folderId, jobId, revision: accepted.revision, error: job.error });
                window.dispatchEvent(new CustomEvent('firstmeasure:pdf_sync', { detail: { status: 'failed', folderId, jobId, error: job.error } }));
                return job;
            }
            if (job.status !== 'completed') continue;
            const serverOutputs = Array.isArray(job.result?.outputs) ? job.result.outputs : [];
            const comparison = serverOutputs.map((output) => {
                const slot = output.slot || (output.mode === 'summary' ? 'summary' : 'main');
                const localSha256 = localChecksums[slot] || null;
                const localRenderSha256 = localRenderChecksums[slot] || null;
                return {
                    slot,
                    local_sha256: localSha256,
                    server_sha256: output.sha256 || null,
                    byte_identical: !!localSha256 && localSha256 === output.sha256,
                    local_render_sha256: localRenderSha256,
                    server_render_sha256: output.render_checksum || null,
                    identical: !!localRenderSha256 && localRenderSha256 === output.render_checksum
                };
            });
            const compared = comparison.filter((item) => item.local_render_sha256);
            const identical = compared.length > 0 && compared.every((item) => item.identical);
            const byteIdentical = comparison.length > 0 && comparison.every((item) => item.byte_identical);
            const log = identical ? console.info : console.warn;
            log('[PDF SYNC] Server render checksum comparison complete.', {
                folderId,
                jobId,
                revision: accepted.revision,
                identical,
                byte_identical: byteIdentical,
                verification: 'render_contract_sha256',
                comparison,
                server_duration_ms: job.result?.duration_ms || null
            });
            window.dispatchEvent(new CustomEvent('firstmeasure:pdf_sync', { detail: { status: identical ? 'identical' : 'different', folderId, jobId, comparison } }));
            return job;
        }
        console.warn('[PDF SYNC] Timed out waiting for the background checksum.', { folderId, jobId, revision: accepted.revision });
        return null;
    }

    async function generateProjectPdfsWithBackgroundSync(folderId, snapshot, runtimeContext = {}, options = {}) {
        if (!folderId) throw new Error('A project id is required for background PDF synchronization.');
        const preparedSnapshot = preparePdfSyncSnapshot(snapshot, { ...options, runtimeContext });
        const serverOutputs = normalizeLocalOutputSpecs(options);
        const localOutputs = Array.isArray(options.localOutputs) && options.localOutputs.length
            ? options.localOutputs
            : serverOutputs;
        const syncEndpoint = buildProjectPdfSyncEndpoint(folderId);
        const syncPayload = {
                source: 'inline',
                snapshot: preparedSnapshot,
                pdf_sync_revision: preparedSnapshot.pdfSyncRevision,
                pdf_render_recipe_version: PDF_RENDER_RECIPE_VERSION,
                persist_files: true,
                update_status: false,
                outputs: serverOutputs
        };
        const enqueueSync = async () => {
            const enqueueStartedAt = performance.now();
            const payloadText = JSON.stringify(syncPayload);
            const payloadBytes = new TextEncoder().encode(payloadText);
            const multipart = payloadBytes.length > PDF_SYNC_SINGLE_REQUEST_MAX_BYTES;
            const data = multipart
                ? await enqueueChunkedProjectPdfSync(syncEndpoint, payloadBytes, options)
                : await fetchPdfSyncJson(syncEndpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    body: payloadText
                }, 'PDF sync enqueue failed.');
            console.info('[PDF SYNC] Server render accepted.', {
                folderId,
                jobId: data.job_id,
                revision: data.revision,
                transport: multipart ? 'multipart' : 'single-request',
                payload_bytes: payloadBytes.length,
                accepted_in_ms: Math.round(performance.now() - enqueueStartedAt)
            });
            return data;
        };
        const enqueuePromise = enqueueSync();

        console.info('[PDF SYNC] Rendering locally while the server renders in the background.', {
            folderId,
            revision: preparedSnapshot.pdfSyncRevision,
            local_outputs: localOutputs.map((output) => output.slot || output.mode),
            server_outputs: serverOutputs.map((output) => output.slot || output.mode)
        });
        const localStartedAt = performance.now();
        const localResult = await generateProjectPdfsLocally(preparedSnapshot, runtimeContext, {
            ...options,
            outputs: localOutputs.map((output) => ({ ...output, persist: false, update_status: false })),
            persistFiles: false,
            updateStatus: false
        });
        const localChecksums = {};
        const localRenderChecksums = await buildPdfRenderContractChecksums(preparedSnapshot, serverOutputs);
        for (const output of localResult.outputs || []) {
            if (!output.blob) continue;
            localChecksums[output.slot] = await sha256Blob(output.blob);
            output.sha256 = localChecksums[output.slot];
            output.render_checksum = localRenderChecksums[output.slot] || null;
        }
        console.info('[PDF SYNC] Local render complete.', {
            folderId,
            revision: preparedSnapshot.pdfSyncRevision,
            duration_ms: Math.round(performance.now() - localStartedAt),
            checksums: localChecksums,
            render_checksums: localRenderChecksums
        });
        const accepted = await enqueuePromise;
        const checksumResponse = await fetch(`${syncEndpoint}/${encodeURIComponent(accepted.job_id)}/client-checksums`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ checksums: localChecksums, render_checksums: localRenderChecksums })
        });
        const checksumRegistration = await checksumResponse.json().catch(() => ({}));
        if (!checksumResponse.ok || checksumRegistration.ok === false) {
            throw new Error(checksumRegistration.message || checksumRegistration.error || 'Failed to register local PDF checksums.');
        }
        const activeSync = {
            ...accepted,
            job_id: checksumRegistration.job_id || accepted.job_id
        };
        console.info('[PDF SYNC] Local checksums registered with the durable server job.', {
            folderId,
            revision: preparedSnapshot.pdfSyncRevision,
            jobId: activeSync.job_id,
            retryOfJobId: checksumRegistration.retry_of_job_id || null
        });
        const monitorPromise = monitorProjectPdfSync(folderId, activeSync, localChecksums, localRenderChecksums, options).catch((error) => {
            console.error('[PDF SYNC] Checksum monitor failed.', error);
            return null;
        });
        window.__lastFirstMeasurePdfSync = {
            folderId,
            revision: preparedSnapshot.pdfSyncRevision,
            jobId: activeSync.job_id,
            localChecksums,
            localRenderChecksums,
            monitorPromise
        };
        return {
            ...localResult,
            snapshot: preparedSnapshot,
            revision: preparedSnapshot.pdfSyncRevision,
            sync: activeSync,
            monitorPromise
        };
    }

    window.FirstMatePDFStandalone = {
        hydrateStandaloneContext,
        loadProjectBundle,
        estimateProjectPdfsApiPayload,
        generateProjectPdfFromSnapshot,
        generateProjectPdfsFromSnapshot,
        generateProjectPdfsLocally,
        generateProjectPdfFromFolder,
        generateProjectPdfsFromFolder,
        generateProjectPdfsViaApi,
        generateProjectPdfsWithBackgroundSync,
        preparePdfSyncSnapshot,
        sha256Blob
    };
})();
