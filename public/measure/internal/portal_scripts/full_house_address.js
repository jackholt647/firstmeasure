/* This private page always creates full-house drafts from a selected Google address. */
(() => {
    'use strict';
    const form = document.getElementById('submit');
    const input = document.getElementById('address');
    const button = document.getElementById('create');
    const status = document.getElementById('status');
    let selected = null, busy = false, autocomplete = null, createdFolder = null;
    const validSelection = () => selected && input.value.trim() === selected.address;
    const refresh = () => { button.disabled = busy || !validSelection(); };

    window.fullHouseAddressUnavailable = window.gm_authFailure = () => {
        selected = null;
        input.disabled = true;
        refresh();
        status.textContent = 'Google address search is unavailable. Refresh the page to try again.';
    };
    window.initFullHouseAddress = () => {
        if (autocomplete) return;
        if (!window.google?.maps?.places?.Autocomplete) return window.fullHouseAddressUnavailable();
        autocomplete = new google.maps.places.Autocomplete(input, {
            types: ['address'], fields: ['formatted_address', 'geometry', 'place_id']
        });
        input.disabled = false;
        status.textContent = '';
        autocomplete.addListener('place_changed', () => {
            const place = autocomplete.getPlace();
            const lat = place.geometry?.location?.lat(), lng = place.geometry?.location?.lng();
            selected = null;
            if (place.formatted_address && place.place_id && Number.isFinite(lat) && Number.isFinite(lng)
                && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
                selected = { address: place.formatted_address.trim(), lat, lng };
                input.value = selected.address;
                status.textContent = 'Address selected. Ready to create the measurement.';
            } else {
                status.textContent = 'Select a property address from the Google suggestions.';
            }
            refresh();
        });
    };
    input.addEventListener('input', () => {
        selected = null;
        status.textContent = 'Select a property address from the Google suggestions.';
        refresh();
    });
    // Enter chooses a prediction; creating a job remains an explicit button action.
    input.addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (busy) return;
        if (!validSelection()) {
            selected = null;
            refresh();
            status.textContent = 'Select a property address from the Google suggestions.';
            return;
        }
        const payload = { ...selected, measurement_scope: 'full_house', measurement_system: document.getElementById('measurement-system')?.value || 'imperial', report_language: document.getElementById('report-language')?.value || 'en-US' };
        busy = true;
        window.FullHouseReferences?.lock(true);
        input.disabled = true;
        refresh();
        status.textContent = 'Preparing imagery…';
        try {
            if (!createdFolder) {
            const response = await fetch('full_house.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Full-House-CSRF': form.dataset.csrf },
                body: JSON.stringify(payload)
            });
            const data = await response.json();
            if (!response.ok) throw Error(data.message || (typeof data.error === 'string' ? data.error : '') || 'Unable to create measurement');
            if (!/^fullhouse_[a-f0-9]{32}$/.test(data.folder || '')) throw Error('The measurement response was incomplete.');
            createdFolder = data.folder;
            }
            await window.FullHouseReferences?.upload(createdFolder, form.dataset.csrf, text => { status.textContent = text; });
            location.href = 'editor.php?folder=' + encodeURIComponent(createdFolder);
        } catch (error) {
            status.textContent = (error.message || 'Unable to create measurement') + (createdFolder ? ' The project is created. Retry uploads to continue without creating another project.' : '');
            button.textContent = createdFolder ? 'Retry reference uploads' : 'Create measurement';
            window.FullHouseReferences?.lock(!!createdFolder);
            busy = false;
            input.disabled = !!createdFolder;
            refresh();
        }
    });
})();
