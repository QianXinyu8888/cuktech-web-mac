/* Navigate to the existing device panels without changing device selection. */
(function () {
    'use strict';
    var nav = document.querySelector('.apple-sidebar nav');
    if (!nav) return;

    function markCurrent(hash) {
        nav.querySelectorAll('a[href^="#"]').forEach(function (link) {
            if (link.getAttribute('href') === hash) link.setAttribute('aria-current', 'location');
            else link.removeAttribute('aria-current');
        });
    }

    nav.addEventListener('click', function (event) {
        var link = event.target.closest('a[href^="#"]');
        if (!link || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        if (window.DeviceBench && window.DeviceBench.isFleet()) window.DeviceBench.exitFleet();
        markCurrent(link.getAttribute('href'));
    });
    window.addEventListener('hashchange', function () {
        markCurrent(window.location.hash || '#cardTop');
    });
    markCurrent(window.location.hash || '#cardTop');
})();
