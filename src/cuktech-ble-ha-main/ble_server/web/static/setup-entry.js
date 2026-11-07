// Loaded after the configuration form and Xiaomi login functions are ready.
if (new URLSearchParams(location.search).get('setup') === 'esp32') {
    openXiaomiModal();
    xiaomiStartQR();
}
