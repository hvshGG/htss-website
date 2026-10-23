/* Progressive enhancement only: all content remains readable without JavaScript. */
(function () {
    'use strict';

    function init() {
        const translations = window.HTSS_TRANSLATIONS || {};
        const supportedLanguages = ['ru', 'kk', 'en'];
        const richTextKeys = new Set([
            'slide2_title', 'slide3_title', 'about_p1',
            'serv_card1_list', 'serv_card2_list', 'serv_card3_list', 'serv_card4_list'
        ]);
        const config = window.HTSS_CONFIG || {};
        const menuButton = document.getElementById('mobile-menu-btn');
        const menu = document.getElementById('mobile-menu');
        const dialog = document.getElementById('contact-dialog');
        const form = document.getElementById('contact-form');
        const submitButton = document.getElementById('contact-submit');
        const status = document.getElementById('contact-status');
        const navbar = document.getElementById('navbar');
        const desktopQuery = window.matchMedia('(min-width: 1200px)');
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
        const inertElements = Array.from(document.querySelectorAll('[data-menu-inert]'));
        const originalInert = new Map(inertElements.map(function (element) {
            return [element, element.inert];
        }));
        let currentLanguage = 'ru';
        let menuOpen = false;
        let bodyOverflow = null;
        let dialogOpener = null;
        let sending = false;
        let statusKey = '';
        let statusKind = '';
        let formMode = 'unconfigured';

        function t(key) {
            const dictionary = translations[currentLanguage] || {};
            const fallback = translations.ru || {};
            const value = Object.prototype.hasOwnProperty.call(dictionary, key) ? dictionary[key] : fallback[key];
            return typeof value === 'string' ? value.replace(/&copy;/g, '©') : key;
        }

        function updateMenuLabel() {
            if (menuButton) menuButton.setAttribute('aria-label', t(menuOpen ? 'close_menu' : 'open_menu'));
        }

        function setStatus(key, kind) {
            statusKey = key || '';
            statusKind = kind || '';
            if (!status) return;
            status.textContent = key ? t(key) : '';
            status.dataset.state = statusKind;
            status.hidden = !key;
        }

        function setLanguage(language) {
            currentLanguage = supportedLanguages.includes(language) ? language : 'ru';
            document.documentElement.lang = currentLanguage;
            const locale = document.querySelector('meta[property="og:locale"]');
            if (locale) locale.content = { ru: 'ru_RU', kk: 'kk_KZ', en: 'en_US' }[currentLanguage];
            document.querySelectorAll('[data-i18n]').forEach(function (element) {
                const key = element.dataset.i18n;
                const value = t(key);
                if (value === key) return;
                if (richTextKeys.has(key)) element.innerHTML = value;
                else element.textContent = value;
            });
            [
                ['data-i18n-placeholder', 'placeholder'],
                ['data-i18n-aria-label', 'aria-label'],
                ['data-i18n-content', 'content'],
                ['data-i18n-alt', 'alt']
            ].forEach(function (pair) {
                document.querySelectorAll('[' + pair[0] + ']').forEach(function (element) {
                    const key = element.getAttribute(pair[0]);
                    const value = t(key);
                    if (value !== key) element.setAttribute(pair[1], value);
                });
            });
            document.querySelectorAll('[data-lang]').forEach(function (button) {
                const active = button.dataset.lang === currentLanguage;
                button.classList.toggle('is-active', active);
                button.setAttribute('aria-pressed', String(active));
            });
            updateMenuLabel();
            if (form) {
                Array.from(form.elements).forEach(function (field) {
                    if (typeof field.setCustomValidity === 'function') field.setCustomValidity('');
                    field.removeAttribute('aria-invalid');
                });
            }
            updateSubmitButton();
            setStatus(statusKey, statusKind);
            try { window.localStorage.setItem('htss_lang', currentLanguage); } catch (_) { /* Private mode can block storage. */ }
            document.dispatchEvent(new CustomEvent('htss:language', { detail: { language: currentLanguage } }));
        }

        function updateBodyLock() {
            const locked = menuOpen || Boolean(dialog && dialog.open);
            if (locked && bodyOverflow === null) {
                bodyOverflow = document.body.style.overflow;
                document.body.style.overflow = 'hidden';
            } else if (!locked && bodyOverflow !== null) {
                document.body.style.overflow = bodyOverflow;
                bodyOverflow = null;
            }
            document.body.classList.toggle('is-locked', locked);
        }

        function focusableElements(container) {
            if (!container) return [];
            return Array.from(container.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')).filter(function (element) {
                return !element.disabled && element.tabIndex >= 0 && !element.closest('[hidden], [inert]') && element.getClientRects().length > 0;
            });
        }

        function setMenu(open, restoreFocus) {
            if (!menu || !menuButton) return;
            menuOpen = Boolean(open) && !desktopQuery.matches;
            menu.hidden = !menuOpen;
            menu.classList.toggle('is-open', menuOpen);
            menuButton.setAttribute('aria-expanded', String(menuOpen));
            document.documentElement.classList.toggle('menu-open', menuOpen);
            inertElements.forEach(function (element) {
                element.inert = menuOpen || originalInert.get(element);
            });
            updateMenuLabel();
            updateBodyLock();
            if (menuOpen) {
                const firstLink = focusableElements(menu)[0];
                if (firstLink) firstLink.focus({ preventScroll: true });
            } else if (restoreFocus && menuButton.getClientRects().length) {
                menuButton.focus({ preventScroll: true });
            }
        }

        if (menuButton && menu) {
            menuButton.addEventListener('click', function () { setMenu(!menuOpen, true); });
            menu.addEventListener('click', function (event) {
                const link = event.target.closest('a[href^="#"]');
                if (!link || event.defaultPrevented) return;
                setMenu(false, false);
                if (event.detail === 0) {
                    let target;
                    try { target = document.getElementById(decodeURIComponent(link.hash.slice(1))); } catch (_) { return; }
                    if (!target) return;
                    const focusTarget = target.querySelector('h1, h2, h3') || target;
                    const temporaryTabindex = !focusTarget.hasAttribute('tabindex');
                    if (temporaryTabindex) {
                        focusTarget.setAttribute('tabindex', '-1');
                        focusTarget.addEventListener('blur', function () { focusTarget.removeAttribute('tabindex'); }, { once: true });
                    }
                    focusTarget.focus({ preventScroll: true });
                }
            });
            desktopQuery.addEventListener('change', function (event) {
                if (event.matches) setMenu(false, false);
            });
            setMenu(false, false);
        }

        document.querySelectorAll('[data-lang]').forEach(function (button) {
            button.addEventListener('click', function () {
                setLanguage(button.dataset.lang);
                if (menuOpen) setMenu(false, true);
            });
        });

        document.addEventListener('keydown', function (event) {
            if (!menuOpen) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                setMenu(false, true);
            } else if (event.key === 'Tab') {
                const items = [menuButton].concat(focusableElements(menu));
                const first = items[0];
                const last = items[items.length - 1];
                if (event.shiftKey && (document.activeElement === first || !items.includes(document.activeElement))) {
                    event.preventDefault();
                    last.focus();
                } else if (!event.shiftKey && (document.activeElement === last || !items.includes(document.activeElement))) {
                    event.preventDefault();
                    first.focus();
                }
            }
        });

        function openContact(opener) {
            if (!dialog || typeof dialog.showModal !== 'function') return false;
            dialogOpener = opener instanceof HTMLElement ? opener : document.activeElement;
            if (menuOpen) setMenu(false, false);
            if (form && dialogOpener && dialogOpener.dataset.sector) {
                const field = form.elements.namedItem('sector');
                if (field && Array.from(field.options || []).some(function (option) { return option.value === dialogOpener.dataset.sector; })) {
                    field.value = dialogOpener.dataset.sector;
                }
            }
            if (!dialog.open) dialog.showModal();
            updateBodyLock();
            const firstField = form && form.elements.namedItem('name');
            if (firstField && !firstField.disabled) firstField.focus({ preventScroll: true });
            return true;
        }

        function restoreDialogFocus() {
            updateBodyLock();
            if (dialogOpener && dialogOpener.isConnected && dialogOpener.getClientRects().length && !dialogOpener.closest('[hidden], [inert]')) {
                dialogOpener.focus({ preventScroll: true });
            } else if (menuButton && menuButton.getClientRects().length) {
                menuButton.focus({ preventScroll: true });
            }
        }

        function closeContact() {
            if (!dialog || !dialog.open) return;
            if (typeof dialog.close === 'function') dialog.close();
            else {
                dialog.removeAttribute('open');
                restoreDialogFocus();
            }
            updateBodyLock();
        }

        document.querySelectorAll('[data-open-contact]').forEach(function (button) {
            button.addEventListener('click', function (event) {
                if (openContact(button)) event.preventDefault();
            });
        });
        document.querySelectorAll('[data-close-contact]').forEach(function (button) {
            button.addEventListener('click', closeContact);
        });
        if (dialog) {
            dialog.addEventListener('close', restoreDialogFocus);
            dialog.addEventListener('click', function (event) {
                if (event.target !== dialog) return;
                const rect = dialog.getBoundingClientRect();
                if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeContact();
            });
        }

        const recipient = typeof config.contactEmail === 'string' ? config.contactEmail.trim() : '';
        const validRecipient = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(recipient) && !/[\r\n?&#]/.test(recipient);
        let endpoint = '';
        if (typeof config.contactEndpoint === 'string' && config.contactEndpoint.trim()) {
            try {
                const configuredEndpoint = config.contactEndpoint.trim();
                const url = new URL(configuredEndpoint, document.baseURI);
                if (config.delivery === 'smtp' && url.origin === location.origin && (url.protocol === 'https:' || url.protocol === 'http:')) {
                    endpoint = url.href;
                    formMode = 'smtp';
                } else if (config.delivery === 'formsubmit' && validRecipient && !/[\\/]/.test(recipient)) {
                    const allowedPaths = ['/ajax/' + recipient, '/ajax/' + encodeURIComponent(recipient)];
                    const allowedEndpoints = allowedPaths.map(function (path) { return 'https://formsubmit.co' + path; });
                    if (allowedEndpoints.includes(configuredEndpoint) && url.href === configuredEndpoint
                        && allowedPaths.includes(url.pathname) && url.origin === 'https://formsubmit.co'
                        && !url.username && !url.password && !url.search && !url.hash) {
                        endpoint = url.href;
                        formMode = 'formsubmit';
                    }
                }
            } catch (_) { /* Invalid endpoint keeps the form disabled. */ }
        }
        if (config.delivery === 'email' && validRecipient) formMode = 'email';

        document.querySelectorAll('[data-contact-email]').forEach(function (link) {
            link.hidden = !validRecipient;
            if (validRecipient) {
                link.href = 'mailto:' + recipient;
                link.textContent = recipient;
            } else {
                link.removeAttribute('href');
                link.textContent = '';
            }
        });
        document.querySelectorAll('[data-contact-email-wrapper]').forEach(function (element) { element.hidden = !validRecipient; });

        function updateSubmitButton() {
            if (!submitButton) return;
            submitButton.disabled = sending || formMode === 'unconfigured';
            submitButton.textContent = t(sending ? 'modal_sending' : formMode === 'email' ? 'modal_email_action' : 'modal_btn');
            submitButton.setAttribute('aria-busy', String(sending));
            if (form) form.setAttribute('aria-busy', String(sending));
        }

        function fieldValue(name) {
            const field = form && form.elements.namedItem(name);
            return field && typeof field.value === 'string' ? field.value.trim() : '';
        }

        function validateForm() {
            let firstInvalid = null;
            const allowedSectors = ['prom', 'comm', 'log', 'eng', 'other'];
            Array.from(form.elements).forEach(function (field) {
                if (typeof field.setCustomValidity !== 'function' || !field.name || field.name === 'website') return;
                field.setCustomValidity('');
                let error = '';
                const value = typeof field.value === 'string' ? field.value.trim() : '';
                if (field.name === 'consent' && !field.checked) error = 'modal_consent_invalid';
                else if (field.required && !value) error = 'modal_required';
                else if (field.name === 'name' && (value.length < 2 || value.length > 80 || /[\u0000-\u001f\u007f]/u.test(value))) error = 'modal_name_invalid';
                else if (field.name === 'phone') {
                    const digits = value.replace(/\D/g, '');
                    if (!/^\+?[\d ()-]+$/.test(value) || digits.length < 7 || digits.length > 15 || value.length > 30) error = 'modal_phone_invalid';
                } else if (field.name === 'sector' && value && !allowedSectors.includes(value)) error = 'modal_sector_invalid';
                else if (field.name === 'message' && (value.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value))) error = 'modal_message_invalid';
                if (error) field.setCustomValidity(t(error));
                if (!field.validity.valid) {
                    field.setAttribute('aria-invalid', 'true');
                    if (!firstInvalid) firstInvalid = field;
                } else field.removeAttribute('aria-invalid');
            });
            if (firstInvalid) {
                firstInvalid.focus();
                firstInvalid.reportValidity();
                return false;
            }
            return true;
        }

        function makeEmailDraft(payload) {
            const sectorKeys = { prom: 'modal_sel_1', comm: 'modal_sel_2', log: 'modal_sel_3', eng: 'modal_sel_4', other: 'modal_sel_5' };
            const lines = [
                t('modal_name') + ': ' + payload.name,
                t('modal_phone') + ': ' + payload.phone,
                t('modal_sector') + ': ' + (sectorKeys[payload.sector] ? t(sectorKeys[payload.sector]) : '—'),
                t('modal_message') + ': ' + (payload.message || '—'),
                t('modal_email_language') + ': ' + currentLanguage.toUpperCase()
            ];
            return 'mailto:' + recipient + '?subject=' + encodeURIComponent(t('modal_email_subject')) + '&body=' + encodeURIComponent(lines.join('\r\n'));
        }

        function makeProviderPayload(payload) {
            const sectors = {
                prom: 'Промышленное строительство',
                comm: 'Коммерческая недвижимость',
                log: 'Логистические центры',
                eng: 'Инженерная инфраструктура',
                other: 'Другое'
            };
            const languages = { ru: 'Русский', kk: 'Казахский', en: 'Английский' };
            return {
                Имя: payload.name,
                Телефон: payload.phone,
                Направление: sectors[payload.sector] || 'Не выбрано',
                Сообщение: payload.message || 'Не указано',
                Язык: languages[payload.language],
                Согласие: payload.consent ? 'Да' : 'Нет',
                _subject: '[HTSS] Новая заявка с сайта',
                _template: 'table',
                _honey: ''
            };
        }

        if (form) {
            form.noValidate = true;
            const phone = form.elements.namedItem('phone');
            if (phone) phone.maxLength = 30;
            const name = form.elements.namedItem('name');
            if (name) {
                name.minLength = 2;
                name.maxLength = 80;
            }
            form.addEventListener('input', function (event) {
                const field = event.target;
                if (typeof field.setCustomValidity === 'function') field.setCustomValidity('');
                field.removeAttribute('aria-invalid');
                if (statusKind === 'error' || statusKind === 'success' || statusKey === 'modal_email_draft') setStatus('', '');
            });
            form.addEventListener('submit', async function (event) {
                event.preventDefault();
                if (sending) return;
                if (formMode === 'unconfigured') {
                    setStatus('modal_unconfigured', 'info');
                    return;
                }
                if (!validateForm()) return;
                if (fieldValue('website')) return;
                const consent = form.elements.namedItem('consent');
                const payload = {
                    name: fieldValue('name'),
                    phone: fieldValue('phone'),
                    sector: fieldValue('sector'),
                    message: fieldValue('message'),
                    consent: Boolean(consent && consent.checked),
                    website: '',
                    language: currentLanguage
                };
                if (formMode === 'email') {
                    window.location.href = makeEmailDraft(payload);
                    setStatus('modal_email_draft', 'info');
                    return;
                }
                sending = true;
                setStatus('modal_sending', 'info');
                updateSubmitButton();
                const controller = new AbortController();
                // External delivery can take longer than the local SMTP endpoint.
                const timeout = window.setTimeout(function () { controller.abort(); }, formMode === 'formsubmit' ? 45000 : 15000);
                try {
                    const response = await fetch(endpoint, {
                        method: 'POST',
                        headers: formMode === 'formsubmit'
                            ? { 'Accept': 'application/json' }
                            : { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                        // Form encoding is supported by FormSubmit and avoids a CORS preflight.
                        body: formMode === 'formsubmit'
                            ? new URLSearchParams(makeProviderPayload(payload))
                            : JSON.stringify(payload),
                        signal: controller.signal
                    });
                    const data = await response.json().catch(function (error) {
                        if (error && error.name === 'AbortError') throw error;
                        return {};
                    });
                    if (response.status === 429) {
                        setStatus('modal_rate_limited', 'error');
                        return;
                    }
                    if (response.status === 503) {
                        setStatus('modal_unavailable', 'error');
                        return;
                    }
                    const accepted = data && (formMode === 'formsubmit'
                        ? data.success === true || data.success === 'true'
                        : data.ok === true);
                    if (formMode === 'formsubmit' && !accepted && data && typeof data.message === 'string'
                        && /activat|confirm.{0,30}email|verif.{0,30}email/i.test(data.message)) {
                        setStatus('modal_activation_required', 'error');
                        return;
                    }
                    if (!response.ok || !accepted) throw new Error('Request was not accepted');
                    form.reset();
                    setStatus(formMode === 'formsubmit' ? 'modal_provider_success' : 'modal_success', 'success');
                } catch (error) {
                    setStatus(error && error.name === 'AbortError' ? 'modal_timeout' : 'modal_error', 'error');
                } finally {
                    window.clearTimeout(timeout);
                    sending = false;
                    updateSubmitButton();
                }
            });
        }

        if (formMode === 'unconfigured') setStatus('modal_unconfigured', 'info');
        else if (formMode === 'email') setStatus('modal_email_hint', 'info');

        if (navbar) {
            function updateHeader() { navbar.dataset.scrolled = String(window.scrollY > 24); }
            window.addEventListener('scroll', updateHeader, { passive: true });
            updateHeader();
        }

        const video = document.getElementById('hero-video');
        if (video) {
            let onScreen = true;
            let sourceLoaded = false;
            video.muted = true;
            video.setAttribute('playsinline', '');
            video.addEventListener('playing', function () { video.classList.add('is-playing'); });
            ['pause', 'error', 'ended', 'emptied'].forEach(function (eventName) {
                video.addEventListener(eventName, function () { video.classList.remove('is-playing'); });
            });
            function updateVideo() {
                if (document.hidden || !onScreen) {
                    video.pause();
                    video.classList.remove('is-playing');
                    return;
                }
                if (!sourceLoaded) {
                    const source = video.dataset.videoSrc || video.getAttribute('src');
                    if (!source) return;
                    video.src = source;
                    video.load();
                    sourceLoaded = true;
                }
                const playback = video.play();
                if (playback && typeof playback.catch === 'function') {
                    playback.catch(function () { /* Poster remains visible when autoplay is unavailable. */ });
                }
            }
            document.addEventListener('visibilitychange', updateVideo);
            if ('IntersectionObserver' in window) {
                const observer = new IntersectionObserver(function (entries) {
                    onScreen = entries[0].isIntersecting;
                    updateVideo();
                });
                observer.observe(video);
            }
            updateVideo();
        }

        let savedLanguage = 'ru';
        try { savedLanguage = window.localStorage.getItem('htss_lang') || 'ru'; } catch (_) { /* Use Russian if storage is unavailable. */ }
        setLanguage(savedLanguage);
        window.HTSS_APP = { setLanguage: setLanguage, t: t, openContact: openContact, closeContact: closeContact };
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
}());
