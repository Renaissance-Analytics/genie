const sites = await window.genie.call('manageSite', { action: 'list' });
document.body.textContent = JSON.stringify(sites);
