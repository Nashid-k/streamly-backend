const fetch = require('node-fetch');
fetch('https://apibay.org/q.php?q=Avengers+Endgame+1080p+multi')
  .then(res => res.json())
  .then(data => console.log(data.slice(0, 2)))
  .catch(console.error);
