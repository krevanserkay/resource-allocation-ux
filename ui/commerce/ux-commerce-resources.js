/**
 * Resource Allocation UX — commerce screen enhancements
 *
 * Features:
 *   1. Hide INELIGIBLE settlements when a pool resource is selected — but keep
 *      eligible-but-full settlements visible.
 *   2. Ascending / descending sort toggle next to the SORT dropdown
 *      (implemented with CSS column-reverse so it never fights the base sort).
 *   3. MIDDLE-click an assigned resource → instant unassign (no conflict with
 *      right-click = back, which used to make the screen close).
 *   4. Filter hides (not just dims) non-matching resources in the LEFT pool.
 *   5. Settlement-assignment mode: left-click a settlement to enter; it is
 *      highlighted and the others dimmed, a banner shows the mode, and pool
 *      resources are assigned one after another with no screen flash.  Stays in
 *      mode until the settlement is full or you right-click.
 *   6. In settlement mode, ineligible pool resources (wrong network, factory /
 *      city resources for towns, …) are hidden per-resource.
 *
 * Implementation notes:
 *   The game's Gameface CSS engine does NOT support :has(), so every "hide"
 *   feature is driven by JS that toggles a plain class.  A MutationObserver
 *   re-applies everything when the base game re-renders (assignments, collapse/
 *   expand of sections, age transitions); createEffects re-apply on model state.
 */

import { createSignal, createEffect, untrack, onMount, onCleanup }
    from '/core/vendor/solid-js/dist/solid.js';
import { ComponentRegistry }
    from '/core/ui-next/services/component-registry.js';
import { useCommerceScreenContext }
    from '/base-standard/ui-next/screens/commerce/commerce-screen-model.js';
import { CommerceResourcesContainer }
    from '/base-standard/ui-next/screens/commerce/commerce-screen-resources-tab.js';
import { ComponentID }
    from '/core/ui/utilities/utilities-component-id.js';

// ─── CSS (Gameface-safe: simple class selectors only, no :has) ────────────────

const styleEl = document.createElement('style');
styleEl.textContent = `
/* Feature 1 / 4 / 6 — JS toggles these to hide a settlement card or a pool
   resource slot.  display:none collapses the layout gap too. */
.ux-settlement-hidden { display: none !important; }
.ux-resource-hidden   { display: none !important; }

/* Feature 5 — settlement-assignment mode visuals. */
.ux-city-dimmed { opacity: 0.3; }
.ux-city-target {
    box-shadow: 0 0 0 0.166rem #E5D2AC;
    border-radius: 0.333rem;
}

.ux-city-banner {
    flex: 0 0 auto;
    margin: 0 0 0.444rem 1rem;
    padding: 0.444rem 0.888rem;
    color: #151B27;
    background: #E5D2AC;
    font-family: inherit;
    font-size: 0.95rem;
    border-radius: 0.333rem;
    display: none;
}
.ux-city-banner.ux-visible { display: block; }

/* Feature 2 — sort direction toggle button. */
.ux-sort-dir-btn {
    pointer-events: auto;
    margin-left: 0.444rem;
    min-height: 3.111rem;
    min-width: 2.333rem;
    padding: 0 0.333rem;
    color: #E5D2AC;
    font-size: 1rem;
    line-height: 1;
    font-family: inherit;
    border-radius: 0.222rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    transition: background 0.15s;
}
.ux-sort-dir-btn:hover { background: rgba(229, 210, 172, 0.12); }

/* CSS-drawn arrow — unicode triangles don't render in the game font.
   Default = descending (down triangle); .ux-asc flips it to an up triangle. */
.ux-sort-dir-btn .ux-arrow {
    width: 0;
    height: 0;
    border-left: 0.4rem solid transparent;
    border-right: 0.4rem solid transparent;
    border-top: 0.5rem solid #E5D2AC;
}
.ux-sort-dir-btn.ux-asc .ux-arrow {
    border-top: 0;
    border-bottom: 0.5rem solid #E5D2AC;
}
`;
document.head.appendChild(styleEl);

// ─── Capture original factory before we register our override ────────────────
const originalFactory = CommerceResourcesContainer.factory;

// ─── Pure helpers (no DOM, no reactive state) ────────────────────────────────

/** Can the given resource currently be assigned to this settlement?
 *  Mirrors the base model's eligibility check (trade network, slot type, …).
 *  NOTE: returns false when the city is full as well — callers combine this
 *  with availableSlots to distinguish "ineligible" from "full". */
function canAssignResourceToCity(resourceValue, cityID) {
    try {
        const location = GameplayMap.getLocationFromIndex(resourceValue);
        const args = { Location: location, City: cityID.id };
        const result = Game.PlayerOperations.canStart(
            GameContext.localPlayerID,
            PlayerOperationTypes.ASSIGN_RESOURCE,
            args,
            false
        );
        return !!result.Success;
    } catch (e) {
        return true; // fail open: never hide on an unexpected error
    }
}

/** Settlement display name from the MODEL SNAPSHOT (used only for the banner
 *  label — never for identity, since names are not unique). */
function snapshotName(cityData) {
    return Locale.compose(cityData.settlementNameData.settlementName);
}

/** Resource class (RESOURCECLASS_CITY / _BONUS / _FACTORY) for a plot value. */
function resourceClass(resourceValue) {
    try {
        const r = Game.Resources.getResourceOnPlot(resourceValue);
        return GameInfo.Resources.lookup(r.resource)?.ResourceClassType ?? null;
    } catch (e) {
        return null;
    }
}

/** Type/network eligibility, INDEPENDENT of whether the settlement is full.
 *  Used to keep full-but-eligible settlements visible while still hiding ones
 *  that could never take the resource (towns for city/factory resources,
 *  factory-less cities for factory resources, wrong trade network). */
function isTypeEligible(model, resourceValue, cityData) {
    if (model.resourceIsConnectedToTradeNetwork(resourceValue)
        !== model.cityIsConnectedToTradeNetwork(cityData.cityID)) {
        return false;
    }
    const cls = resourceClass(resourceValue);
    const isTown = !!cityData.settlementNameData.isTown;
    if (cls === 'RESOURCECLASS_FACTORY') {
        return !isTown && !!cityData.factoryResourceData?.hasFactory;
    }
    if (cls === 'RESOURCECLASS_CITY') {
        return !isTown;
    }
    // RESOURCECLASS_BONUS (towns + cities) or unknown → don't hide.
    return true;
}

/** Resource value of an unassigned pool resource by display name, restricted to
 *  the network section that matches the target city (reduces name ambiguity). */
function findAvailableResourceValue(model, displayName, cityId) {
    const wantConnected = model.cityIsConnectedToTradeNetwork(cityId);
    for (const section of model.data.resourceTabData.availableResourceSectionData) {
        if (section.isConnectedToTradeNetwork !== wantConnected) continue;
        for (const ss of section.subSections) {
            for (const r of ss.resourceSlotData) {
                if (Locale.compose(r.resourceProps.resourceName) === displayName) {
                    return r.resourceValue;
                }
            }
        }
    }
    return null;
}

const AVAIL = '[data-name="available-resources-container"]';
const SLOTTED = '[data-name="slotted-resource-container"]';
const CITY_ACT = '[data-name$="-city-resource-activatable"]';
// CollapsibleContainer root for each section carries these classes.
const AVAIL_SECTION = '.text-secondary.w-full.h-auto.mb-2';
const SLOTTED_SECTION = '.text-secondary.w-full.mb-2';

/** Pair each settlement's model data with its DOM card by POSITION, not name —
 *  settlement names are NOT unique (the player can have two identically-named
 *  settlements), so any name-based lookup is ambiguous.  City cards render in
 *  model order within each section; a collapsed section simply contributes no
 *  cards.  Returns [{ cityData, el }]. */
function cityDomPairs(model) {
    const pairs = [];
    const sectionEls = document.querySelectorAll(`${SLOTTED} ${SLOTTED_SECTION}`);
    const sections = model.data.resourceTabData.slottedResourceSectionData;
    for (let i = 0; i < sections.length; i++) {
        const sEl = sectionEls[i];
        if (!sEl) continue;
        const acts = sEl.querySelectorAll(CITY_ACT);
        sections[i].cityResources.forEach((cityData, j) => {
            if (acts[j]) pairs.push({ cityData, el: acts[j] });
        });
    }
    return pairs;
}

function cityDataFromDom(model, cityEl) {
    return cityDomPairs(model).find(p => p.el === cityEl)?.cityData ?? null;
}

/** Unassign the slotted resource the user clicked, identified by the clicked
 *  settlement card (by position) and the slot's POSITION within it.  The
 *  `.size-19` dropzones inside a city card are exactly the slotted resources in
 *  model order; empty/ghost slots use different sizes. */
function unassignSlottedFromDom(model, draggable) {
    const cityEl = draggable.closest(CITY_ACT);
    if (!cityEl) return false;
    const cityData = cityDataFromDom(model, cityEl);
    if (!cityData) return false;
    const dz = draggable.closest('.size-19');
    if (!dz) return false;
    const index = Array.from(cityEl.querySelectorAll('.size-19')).indexOf(dz);
    const slotted = cityData.slottedResources[index];
    if (!slotted) return false;
    model.clickSlottedResource({ resourceValue: slotted.resourceValue, cityID: cityData.cityID });
    model.unslotSelectedResource();
    return true;
}

// ─── UxCommerceWrapper component ─────────────────────────────────────────────

function UxCommerceWrapper(props) {
    const model = useCommerceScreenContext();

    const [sortDescending, setSortDescending] = createSignal(true);
    const [cityModeId, setCityModeId] = createSignal(null);

    let bannerEl = null;

    // ── Feature 4 + 6: pool-resource visibility ──────────────────────────────
    function applyAvailableVisibility() {
        const container = document.querySelector(AVAIL);
        if (!container) return;

        const id = cityModeId();
        const filter = model.selectedResourceFilter();
        const filtering = !id && filter && filter !== 'DEFAULT';

        const sectionEls = container.querySelectorAll(AVAIL_SECTION);
        const sections = model.data.resourceTabData.availableResourceSectionData;

        sections.forEach((section, i) => {
            const sEl = sectionEls[i];
            if (!sEl) return;
            // Within a section, .size-19 dropzones render in the same order as
            // the flattened resourceSlotData (For loops preserve order; empty
            // subsections render nothing).  A collapsed section has no dropzones.
            const dropzones = sEl.querySelectorAll('.size-19');
            const resources = [];
            section.subSections.forEach(ss =>
                ss.resourceSlotData.forEach(r => resources.push(r)));

            dropzones.forEach((dz, j) => {
                const r = resources[j];
                let hide = false;
                if (r) {
                    if (id) {
                        hide = !canAssignResourceToCity(r.resourceValue, id);
                    } else if (filtering) {
                        hide = !r.yieldTypes.includes(filter);
                    }
                }
                dz.classList.toggle('ux-resource-hidden', hide);
            });
        });
    }

    // ── Feature 1: hide ineligible (but not full) settlements ────────────────
    function applySettlementVisibility() {
        const container = document.querySelector(SLOTTED);
        if (!container) return;

        container.querySelectorAll('.ux-settlement-hidden')
            .forEach(el => el.classList.remove('ux-settlement-hidden'));

        const sel = model.selectedResource();
        // Only relevant when a pool resource is selected and we are NOT in
        // settlement mode (settlement mode dims instead of hiding).
        if (sel.resourceValue === -1 || cityModeId()) return;

        for (const { cityData: c, el } of cityDomPairs(model)) {
            // When the settlement has an open slot, canStart is authoritative.
            // When it is FULL, canStart can't tell "wrong type" from "no room",
            // so fall back to the fullness-independent type check — that keeps
            // full-but-eligible settlements visible while still hiding full
            // settlements that could never take this resource (e.g. a full town
            // for a city/factory resource).
            const hide = c.availableSlots.length > 0
                ? !canAssignResourceToCity(sel.resourceValue, c.cityID)
                : !isTypeEligible(model, sel.resourceValue, c);
            if (hide) el.classList.add('ux-settlement-hidden');
        }
    }

    // ── Feature 5: settlement-mode highlight + banner ────────────────────────
    function applyCityModeVisual() {
        const container = document.querySelector(SLOTTED);
        if (!container) return;

        container.querySelectorAll('.ux-city-dimmed, .ux-city-target')
            .forEach(el => el.classList.remove('ux-city-dimmed', 'ux-city-target'));

        // Ensure the banner exists as the first child of the right panel.
        if (!bannerEl || !bannerEl.isConnected) {
            bannerEl = document.createElement('div');
            bannerEl.className = 'ux-city-banner';
            container.insertBefore(bannerEl, container.firstChild);
        }

        const id = cityModeId();
        if (!id) {
            bannerEl.classList.remove('ux-visible');
            return;
        }

        // Highlight the target by cityID match (names are not unique); dim the
        // rest.
        let targetName = '';
        for (const { cityData: c, el } of cityDomPairs(model)) {
            if (ComponentID.isMatch(c.cityID, id)) {
                el.classList.add('ux-city-target');
                targetName = snapshotName(c);
            } else {
                el.classList.add('ux-city-dimmed');
            }
        }

        bannerEl.textContent =
            `Assigning to ${targetName} — click resources, right-click to exit`;
        bannerEl.classList.add('ux-visible');
    }

    // ── Feature 2: sort direction via CSS column-reverse ─────────────────────
    function applySortDirection() {
        const container = document.querySelector(SLOTTED);
        if (!container) return;
        const desc = sortDescending();
        // The parent of each city activatable is its section's flex column.
        const wrappers = new Set();
        container.querySelectorAll(CITY_ACT).forEach(a => {
            if (a.parentElement) wrappers.add(a.parentElement);
        });
        wrappers.forEach(w => {
            w.style.flexDirection = desc ? '' : 'column-reverse';
        });
    }

    function reconcile() {
        applyAvailableVisibility();
        applySettlementVisibility();
        applyCityModeVisual();
        applySortDirection();
    }

    // Reactive triggers — re-apply when model state changes.
    createEffect(() => {
        cityModeId();
        model.selectedResourceFilter();
        // Re-run when the available list changes (assignments / age changes).
        const sections = model.data.resourceTabData.availableResourceSectionData;
        void sections.length;
        sections.forEach(s => s.subSections.forEach(ss => void ss.resourceSlotData.length));
        applyAvailableVisibility();
    });

    createEffect(() => {
        model.selectedResource();
        cityModeId();
        model.data.resourceTabData.slottedResourceSectionData
            .forEach(s => void s.cityResources.length);
        applySettlementVisibility();
    });

    createEffect(() => {
        cityModeId();
        model.data.resourceTabData.slottedResourceSectionData
            .forEach(s => void s.cityResources.length);
        applyCityModeVisual();
    });

    createEffect(() => {
        sortDescending();
        model.data.resourceTabData.slottedResourceSectionData
            .forEach(s => void s.cityResources.length);
        applySortDirection();
    });

    // ── Feature 5: auto-exit settlement mode when the settlement fills up ─────
    createEffect(() => {
        const id = cityModeId();
        if (!id) return;
        let slotsLeft = null;
        for (const section of model.data.resourceTabData.slottedResourceSectionData) {
            for (const c of section.cityResources) {
                if (ComponentID.isMatch(c.cityID, id)) slotsLeft = c.availableSlots.length;
            }
        }
        if (slotsLeft === 0) untrack(() => setCityModeId(null));
    });

    // ── engine-input handler: Features 3 + 5 (capture phase, fires first) ─────
    function handleEngineInput(e) {
        const d = e.detail;
        if (d.status !== InputActionStatuses.FINISH) return;

        // Feature 3 — MIDDLE-click a slotted resource → instant unassign.
        // Only when not mid-interaction (no resource currently selected).
        if (d.name === 'mousebutton-middle') {
            if (model.selectedResource().resourceValue !== -1) return;
            const draggable = e.target.closest?.('.draggable-resource');
            const inSlotted = e.target.closest?.(SLOTTED);
            if (draggable && inSlotted && unassignSlottedFromDom(model, draggable)) {
                e.stopPropagation();
                e.preventDefault();
            }
            return;
        }

        // Right-click — cancel whatever temporary view we are in, and consume
        // the event so it does not also close the screen:
        //   - in settlement mode  → exit settlement mode (Feature 5)
        //   - a resource selected → deselect it, restoring all settlements
        //     (Feature 1 exit: "right-click anywhere" to leave the filtered view)
        // Otherwise let the normal back/close happen.
        if (d.name === 'mousebutton-right') {
            if (cityModeId() !== null) {
                setCityModeId(null);
                e.stopPropagation();
                e.preventDefault();
            } else if (model.selectedResource().resourceValue !== -1) {
                model.deselectSelectedResource();
                e.stopPropagation();
                e.preventDefault();
            }
            return;
        }

        if (d.name !== 'mousebutton-left') return;

        const inSlotted   = e.target.closest?.(SLOTTED);
        const inAvailable = e.target.closest?.(AVAIL);
        const onResource  = e.target.closest?.('.draggable-resource');

        // Feature 5a — in settlement mode, clicking a pool resource assigns it.
        // We do the whole select→slot→deselect synchronously and stop the event
        // before the Activatable can run, so there is no intermediate paint
        // (no "selection mode" flash) and we stay in settlement mode.
        if (inAvailable && cityModeId() !== null && onResource) {
            const resName = (onResource.getAttribute('data-name') ?? '')
                .replace(/-Activatable$/, '');
            const cityId = cityModeId();
            const resVal = findAvailableResourceValue(model, resName, cityId);
            if (resVal !== null) {
                e.stopPropagation();
                e.preventDefault();
                model.clickAvailableResource({ resourceValue: resVal, cityID: undefined });
                model.slotSelectedResource(cityId);
                model.deselectSelectedResource();
            }
            return;
        }

        // Feature 5b — clicking a settlement card while no resource is selected
        // enters / switches / exits settlement mode.
        if (inSlotted && model.selectedResource().resourceValue === -1) {
            const cityEl = e.target.closest?.(CITY_ACT);
            if (!cityEl) return;

            // Don't hijack clicks on nested controls (the "return all resources"
            // button, factory display, slotted resources …).  Those are their own
            // Activatables; let them handle the click normally.
            const innerActivatable = e.target.closest?.('[data-activatable="true"]');
            if (innerActivatable && innerActivatable !== cityEl) return;

            const cityData = cityDataFromDom(model, cityEl);
            if (!cityData) return;

            const prev = cityModeId();
            if (prev && ComponentID.isMatch(prev, cityData.cityID)) {
                setCityModeId(null);                       // re-click target → exit
            } else if (cityData.availableSlots.length > 0) {
                setCityModeId(cityData.cityID);            // enter / switch
            } else {
                return;                                    // full settlement → ignore
            }
            e.stopPropagation();
            e.preventDefault();
        }
    }

    // ── Mount: observers, listener, sort button ──────────────────────────────
    onMount(() => {
        window.addEventListener('engine-input', handleEngineInput, true);

        // Re-apply our DOM changes whenever the base game re-renders (childList /
        // subtree only — our own class/style writes are attribute mutations and
        // therefore never re-trigger this, so there is no feedback loop).
        let rafPending = false;
        const observer = new MutationObserver(() => {
            if (rafPending) return;
            rafPending = true;
            requestAnimationFrame(() => { rafPending = false; reconcile(); });
        });

        function observeWhenReady(attempt = 0) {
            const avail = document.querySelector(AVAIL);
            const slotted = document.querySelector(SLOTTED);
            if (avail && slotted) {
                observer.observe(avail, { childList: true, subtree: true });
                observer.observe(slotted, { childList: true, subtree: true });
                reconcile();
                return;
            }
            if (attempt < 60) requestAnimationFrame(() => observeWhenReady(attempt + 1));
        }
        observeWhenReady();

        // Feature 2 — inject the sort-direction toggle button (retry until the
        // filter/sort header exists).
        function injectSortButton(attempt = 0) {
            const filterAndSort =
                document.querySelector('[data-name="filter-and-sort(HSlot)"]');
            if (!filterAndSort) {
                if (attempt < 60) {
                    requestAnimationFrame(() => injectSortButton(attempt + 1));
                }
                return;
            }
            if (filterAndSort.querySelector('.ux-sort-dir-btn')) return;
            const btn = document.createElement('button');
            btn.className = 'ux-sort-dir-btn';
            btn.setAttribute('title', 'Toggle sort direction (descending / ascending)');
            const arrow = document.createElement('span');
            arrow.className = 'ux-arrow';
            btn.appendChild(arrow);
            filterAndSort.appendChild(btn);
            createEffect(() => { btn.classList.toggle('ux-asc', !sortDescending()); });
            btn.addEventListener('click', ev => {
                ev.stopPropagation();
                setSortDescending(v => !v);
            });
        }
        injectSortButton();

        onCleanup(() => {
            window.removeEventListener('engine-input', handleEngineInput, true);
            observer.disconnect();
        });
    });

    return originalFactory(props);
}

// ─── Register our wrapper with higher priority than the base default (0) ──────
ComponentRegistry.register({
    name: 'CommerceResourcesContainer',
    overridePriority: 1000,
    createInstance: UxCommerceWrapper
});
