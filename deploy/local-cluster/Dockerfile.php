FROM php:8.3-fpm-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends libcurl4-openssl-dev libonig-dev libsqlite3-dev \
    && docker-php-ext-install curl mbstring pdo_sqlite sqlite3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/public
COPY deploy/local-cluster/php-fpm.conf /usr/local/etc/php-fpm.d/zz-firstmeasure.conf
