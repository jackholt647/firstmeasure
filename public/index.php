<?php

// Keep the application entry point independent of proxy scheme detection. A
// relative redirect preserves HTTPS when TLS terminates at the load balancer.
header('Location: /portal/', true, 302);
exit;
