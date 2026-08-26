<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="/fonts.css">
    <style>
        * { box-sizing: border-box; }

        html,
        body {
            width: 100%;
            height: 100%;
            margin: 0;
            overflow: hidden;
        }

        body {
            font-family: 'Montserrat', 'Segoe UI', Roboto, sans-serif;
            color: #111827;
            background:
                linear-gradient(100deg, rgba(255,255,255,0.96) 0%, rgba(255,255,255,0.82) 58%, rgba(255,255,255,0.20) 100%),
                url('images/gutter_installer.png') center / cover no-repeat;
        }

        .banner {
            height: 100%;
            display: grid;
            align-items: center;
            padding: 10px 12px;
        }

        .copy {
            display: grid;
            gap: 3px;
            min-width: 0;
            max-width: 220px;
        }

        .eyebrow {
            color: #b1241c;
            font-size: 8px;
            font-weight: 900;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            white-space: nowrap;
        }

        h1 {
            margin: 0;
            font-size: clamp(18px, 6.4vw, 25px);
            line-height: 1;
            letter-spacing: 0;
        }

        p {
            margin: 0;
            color: #374151;
            font-size: 9.5px;
            line-height: 1.15;
            font-weight: 700;
            max-width: 26ch;
        }

        @media (max-width: 360px) {
            .banner {
                padding: 8px 10px;
            }

            .copy {
                max-width: 190px;
            }

            .eyebrow {
                font-size: 7.5px;
            }

            h1 {
                font-size: 17px;
            }

            p {
                font-size: 8.5px;
                max-width: 24ch;
            }
        }
    </style>
</head>
<body>
    <main class="banner" aria-label="FirstMate login marketing">
        <section class="copy">
            <div class="eyebrow">Introducing</div>
            <h1>Gutter Reports</h1>
            <p>Add Gutter Details and Diagrams for Just $2</p>
        </section>
    </main>
</body>
</html>