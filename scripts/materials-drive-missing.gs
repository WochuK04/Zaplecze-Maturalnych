/**
 * Audyt 275 zaginionych plików — sprawdza KAŻDY identyfikator z osobna.
 *
 * Po co osobno, skoro mapowanie drzewa już było: `Files.get` działa niezależnie
 * od folderu i pokazuje pliki W KOSZU, których listowanie po katalogach nie widzi
 * (`trashed = false`). Dysk trzyma kosz 30 dni, więc to rozstrzyga, czy plik da
 * się jeszcze odzyskać, czy przepadł na stałe.
 *
 * URUCHOMIENIE: wklej do Apps Script (Usługi + → Drive API → Dodaj) i odpal
 * `audytZaginionych`. Nie trzeba tworzyć żadnych zakładek — identyfikatory są
 * w kodzie, a zakładka „wynik" powstanie sama.
 *
 * WERDYKTY:
 *   ok          + w_koszu=nie  → plik żyje, leży poza zmapowanymi katalogami
 *   ok          + w_koszu=tak  → skasowany, ale do odzyskania z kosza
 *   brak-pliku                 → usunięty na stałe (jedyny nieodwracalny)
 *   brak-dostepu               → istnieje, ale nie z tego konta
 */

var ARKUSZ = 'wynik';
var LIMIT_MS = 4.5 * 60 * 1000;
var KLUCZ = 'audyt_zaginionych_kursor';

var IDENTYFIKATORY = [
  '1Zz1ftm7c8XWDnjlezxt4rvkaAEM7WJEQ', '1SsMatGSHtQB8O5dTS5avwAPKvzBNTWkS', '1mfWyE_KBfYeWT0njym58oR5cuTCKpzM3', '1sn7Jz8vtmKdqypiUjbWe5D93jQ6QloQe',
  '10YKi-WJXsKpLma7wtLTLvXBnFmkY1OPx', '179TAYIZj9DboBuUH7Hipdl2o8djj9-Gi', '1RvzASqfDBOS9v0-QB4voubG0UQfH6T8E', '15hBaqmKckc8b3azS_AZwd7RTh3U46Ex8',
  '1fR8tBF3XSdAn4-bVg4bnbU7M0tUM--yd', '1P67-GDlkAc-a2cDr4ZRGtpBuJFtoLFXv', '10M9Azyrkx2GE_Z70PjvhCd0DP_MiyN5V', '15_KZHztLSPwOkFG8kqjUc7qMqTYpnIzR',
  '1knYY8jnnhB28pNnWaeU3XghWmLYXEnxZ', '1-bpRVNv0SRRIS0YXFH6Czl1BNVi9MeDk', '1VgZP-adzgW8TuUYAHXAyDRzX50u5LKly', '1HdPWeBBKuuvSPrGlCXqW9EwYKuyfBGe5',
  '19ri4TA5m-W6QzXDY8RD0AR1em_lIqkpK', '1isq6B0yrsGLGm8UxqnRRYCkeUt0z2VZq', '1F0ko_Ysh54w1xz1MNiO1I6AeTvnJ7tpA', '11m7jYzNCHAnHrNb9QCTjdppww1E_Ex2k',
  '10dwPLdyRixs2wL2_Vu0u_Ir4nMVA_5iG', '14f3F4EMONKQkf0_V1DsICYWKDHSR5RSp', '1gcGJdlWY_Q0jPUNU0WtZmRS_c9vDDhE5', '1K-lSeDHClIKnHmnPjeF_kQHiR8wlSeuL',
  '1jxwpo0oumjGeUcXYc02XEz_AQWQWXXTi', '1qAUMTATjNjTL7QSkPkoHcTsOrYyIjIaL', '1jaD5xB6PH8GMy151HEfkcDx7BCalIVwZ', '1NVZNE1FTfUOLRD5525kA6UdqSM-UgFQM',
  '1k5yg9jkKa9SWBD_raUZYXmRpxN3rfr2N', '19zErz7Xgvs49iuzj3pZXCIMum0gS_oS-', '1aWiKX6JFx6_a6SnLw8fgfQTwnDX0lbNC', '1q-yOev1qe401oLYJuY83HbYVhXJOejJ6',
  '1L36RPhNMIKnvVRggYK90dEUWBaYioh7h', '1u1gBeS59CSKLZJ9VsYb5VmP1eOX1_236', '1F002wBTmISYzdP4eyFdgQqaVpDpHzLvy', '1bYD160VvKucSjheuI-jzNO3AnOWMDCFv',
  '1IfK1hNizfdV_4i6Kmir-3Ew-ecNsCha3', '1sry1Y3-u4cXzQO1_4bTbwWe-cLJJ0ek6', '1TkazPBkRkXtqF2QC4QmTN5c4Yrxqqn9n', '1IPBn7yO3GcBlKfrDqzvc2tarsTL6ME8k',
  '1L6_NPUTMCToV0C7ixBWHitA7qaDvfz58', '1-4kc-p2HANZBHpGGizfvTFCW7SOzA5V3', '1mtZgCpTM_9Ir-cLwuFiiODbYkqW3HtOS', '1WRLFHdmKjuOLxJLfZUbocYUXPryiQ6ri',
  '1Fb2IohgGHtLPbxuZCw38v47y8xaVtVbn', '1EbhUgia9Z5S3hPdpvz7-f3z-8U3tVC5k', '1N8X0j39kkL6CFmn6SxuaViMLm_DFOfRC', '1RE5KViJPJ4d--SNZGyIBCAph7gy94dnL',
  '1pUIgTyoI5FbGHzo_pycsMxASDYDSdb2K', '1irhGmJbZ625p8h59AvaVhxxrftjXrd8b', '1H9opZnWc5q0dpb8M_exhKjc4affscQjS', '1F202gSS3aTLoxunWQkuPP_V0ldz054Gb',
  '1U3Ssp0emdgzsCtpwJQuALgu46LCUz_sE', '1huXw7Zq_tM3-q1eBhkiHsjMV4DNnqv_V', '1d0jGArc2Rd9OHsGZMmjCZtu6nTIN5-l-', '1f7qwevkhGNHEwrSGVaY5mk3b0yt6O7gc',
  '11AyRbX2su3bMgRQe5PN2s7F_kPbta1tn', '1Sgtt0qW4CniXYPhgYaPMTDsX1Xn9A8ne', '1CoOuewXVUn7trP6cC4ngc56D92xz_scT', '1ctjqgALtNRTAFXBpVNjSVGskps97cv9B',
  '1Zf0KcI_O9imj4XLAu1mc1JH9V4rJKIux', '19BDc4-P9lj0u3uwT6CjWLy5CapSV2ImC', '1hjL-q9jBP3w6Sb_y-PpMxE2zz2MrVTBC', '1iVKzenwBadqQXVsFTFuaNK_gOTYZjWKn',
  '1rOk4bVJQxDs8n7PBI-3BFrnSTiuVwu0p', '1eNWTupMcXr5abB1AatvfZfAQ4SkWkB6o', '1OGeBYbtVslEYouaL9ABQ8GL_g6tQwDSG', '1Tv_Sev_F8OMw9GS-rYmTddbX28lKmk9H',
  '13WNAPUyafw3xFsJ9B7tEnVG0Wh2yJEyI', '1m37rHU9K7kxYqkAlxf_ICZ_YS5bHhq8q', '18gnWN5SZjApsAJBaGdfe1lqjgRtLvzu0', '13wBdlclXcm4mL75GWLW8nVirKYWIGPqf',
  '1MGMp2RBmc5Ir6F2HlSAKXGaCetx1Ht-M', '1pnrF3rxjScbLHT3JdmW07T9ONyQT6U0-', '1PMzdO1XScuLjIE4klaeEHit0j3cvHXVf', '158J2IhiTyhuBTIqxy4DiPhz8424tr9qN',
  '1oksuHeOdfLDSaSfJsQR3Fuu7BQKhWEe4', '1zBQ2QY8fFIWzwwOsF2IvA3uMPWoRVP4i', '1dWTfj6Rs3ZS-nC0ZOxldbk7K2U4S1CRW', '1C69luqxYoVJoQg29K8HHMHLWXo-kfdT-',
  '1IPGEh6bBS-iyHF6-NjoLHuNU55WHqzJf', '1BBKtwhW1BXMpenTbAQ8R03NJOQ07L5m-', '1J_SJDDEL3dGXVYrtBYqCj38sFjpoJlbv', '1dC77aeNDGJ2UgAGsJDjZyK3KTGoa9Q8B',
  '16mnefjkTCn4Sf0HT9bSv0eF4Vjcmhnyy', '1KvC87J3gcJjFCN6WyTg5INmRHFHWprPj', '1Enjz7869H1f8uRCyJlSDOguM9wdIEttZ', '1J9rW0wRr0Xmjaha51jnH--Y4spKxs3Nq',
  '1MZAGtMGaQVCYyckL-qpsL0tRY2GYf5eM', '1L048nqBJpXF_PofsJizuOf4aruHZhiYH', '1BJVCicv4yiWP7avDiGqlmCBITA4m7bn-', '1Utqi8_0hpb12tdGKVr1qRc323WMaFaDd',
  '1WeDdyRsbN-lJGmk6hJAPXBYAdCuHawHe', '1YW1iGZms6mHxC902P1HkrGf5F-yzNGVi', '14TCRgWFnn_OheizcmgHX1BXZgxz3rC4y', '1P_0uqM729JyqsbtqYlHKTpOwOu-cIuST',
  '1xDqw8XG3cpycSNXaxHx9_MSTnCyQ4Wej', '1T5hq1zAXiLthaTZHiloNyEScLsE7mv5N', '1zsGN4BD35QxKQRh01UInA4TnXV6acVqO', '1nREa5QQJjfQmgbE7okTi1YzbNTIRDXyA',
  '1xOebhdtS6VZJGyEU9Vakccjg_lkiVdy5', '1zlRMbVD4AlUXFWlghu1wzcjJmu2qLGoF', '1-RoB-P6boff67phyPf-2AQuCMYoJsbH_', '1xp7q4_6gJbQQ7ovN53oNx5hmgWujWfa_',
  '1PBq_s18-pNkBUveQPx4gLmLInq53dmoq', '10450SEsAsAlkgS-5VLMTdsTgyYAEYQG0', '1lZSVjEkOs9PQlstbDI8JB4JEY8u72FLm', '1dLUG9xDeWYQiTemtgBYBgXSOoTF3x1BE',
  '1iDGUHWHdL1-2UHy24UzhXiZ3leW5NqLC', '1ohcYChmhYVSr3zfne7DUUp29BVtKL3qe', '1rLvG0vcoc2xSDcV220FyWih7mgguzvnz', '1jMaxDjwUhtE2Uf3XFhHEZ3exIZ3B-G2P',
  '1issJoZOwdOr_CyTYCzUpXh0AtOD2WAme', '1ZfpnA1qfyQEjHvt-unqAxo6ZLaaW7AmY', '1SNgsK9bFkq8T9hsiUdqxOmmUakKin4c5', '1IiF1RFbRl4egbhX9k6qaQXns61ThOFa0',
  '164hx6sSDxTkxwK8wHJOnJ3TOw4VTwHrK', '1tyOmHKJmgf8PC3obrBIN2El665F1GqgP', '1-b8uCHIiNQOZHj4ND-uBHs5OAe5vTWsm', '12EmqktMbCTVKFBLxBhie1uscn05Hlu8J',
  '1by6u5669DSRvecaLV_VKO1UbboJ8EE1X', '1pztRQsj0MrRmHUuDEoj4vmy6d-RJmLhV', '1AeA1XHCxAqjOahbXhAHmyZJ4gF2IGLZb', '1gWWoltcVLv2_AFlcEfwTwj7pONYcMMCA',
  '1yVOuxe1rM_Pxnv9tA8NGYaraAkT7ZX1Z', '1fV2K2yGg5Eg-dWhVf2Q6G94JdXU9tlcN', '18BnP4vRgQLaRMl4wbiVFaOdTxlDxhrh_', '1embaWLyHtNgFrxaq3X0K-huhIQG67-va',
  '1hz4UvI3jHer0-cYv7pRUx1bzrn4kXl3Q', '1l9G23E2bfPLa5lzNaPQC0SxxzE84CIj-', '1J_yNoMe8qq_AMqQ_vsFs4aubnEBhziG1', '14wPdHMvzomlgYaFAIuHxzEQOcXJrMyQS',
  '1scsf2tzOJivUB-QbdzHUx-FQozRHIFE4', '1mtm6heYBDnLd-nrwn-vSNpAG_I_PUsVk', '1zegY7Uv86utyglKMU8mtjGmdFoLI0iYJ', '1PV9T852Frbmit9dF14sBo_1YuO36D1ta',
  '18RY84nWrtb3mJ7Dnshx1PfTdy1R58D3B', '1kj5RQPEtUHDvoOfgtjjyk2wKWVrcwKbe', '1PRr0t6poNqUC9qEAV-VdijMsRIxb4nSL', '1Tb1QN0VC9S-_qf2SyagDlKhF8LIr2MiE',
  '1c4CoPUOkv38gs5pTElaas4GCcR5Zl2kv', '1nfaTytCcfyT_r34923nwCnObrfG3lk_P', '15-SrwK06AGDA1r25v7h3mN5n7RQIthWX', '1AYxUw4ADR2FLgPD7Rh9Eu3sFFHad8INX',
  '18H-TX5zexfRX0C3VE5unewRdn12SQ8Fb', '1JqGGHM6eHuRU5u5HYCSMTX6hO9js7mn9', '1KXZ7_UxBC76ZzSc7AunPCWX-0ujgHIFT', '1JmJIsvY23Nhlse5cDxrfFajwHFLdEIk1',
  '1L8lUlH3wDuZeiLAZ-IqaNBIQ15sHyWSC', '1izlLXOZDKlYD5d2gqDquNLPI3ijLh0el', '1oqdcaKfmDYMpX4xbf_5A6ZFWo0WX1g3p', '1TXOfy5BFNoczcSdXxoQcobUe3l0mJx5O',
  '1-BPEtr23m53EzTz-03l3WFAK8XxsEwqi', '1sUfqYf-O9r4XeUHFksQL4oGS61tXN6Tg', '1NKXwgS1fSqXSYN3jB4hqYoJamImnKnju', '1OHbxP13KWGl6ST-7W8ZvBtAU-yOC7zXx',
  '1CCgfSJbMkoag_KmAmRMCAb2Dv4w65l7k', '1IAGE0LqFsDL1JNPwyy3-7v4eUSvbkIxE', '15c0GvawEdteC2KoxzbQte0KMyubcZZtI', '1jBeLqkVO5jnCTk0iLVheHmOztexzkKTM',
  '1g5ErMw74aijWgH1KHymBQ8SqCyC7GoAQ', '1ayHAspUe9eMQ0y-a6avC6PHcqjP4xi_8', '1mlAKHK027HFHAGL6drgsEBOZxezUj1lb', '1XN2tqKMzaRgWtErPehddcuoUoI8OB7iU',
  '1ugY2tDHzEqm0gLeg4C_eL3jqQPdcX3DC', '1bdXd8dD2Bimwc_e4fVQCVldu3ornx1JS', '1iZ8FfvTb5zwhUk85a8bXssxz1L1htRc33', '1oyudNCTEuaMHfDWHyQYoivOjjji8NyxV',
  '1G419cX_pLwosZpCzOWZ0iAB2bzZV0GoL', '1RcgBrfzg1frGUUZIwDgPs-SlFkD6FfDj', '1Y65aiv6oNQnPMul-LZ7SIAM4F0VChvyf', '12C7I4g-JBX5a8y51wv2XN2eLHQVXqxdH',
  '1-7u_hpn-EsAQw-OCJeCdOWgmSvWZ7Tz4', '13bDV5SWzJ0qFfMTuC1Io2qH6hZBXpIOo', '1OkFJX94umrn-wzcqi_oFbXGbGZ5GwlgD', '1nPdo66ZhW0BYyP6xvjwiEe2zhxo-j3-A',
  '1u45DYHkagRvKDtDp25JlVlvs44aY1S8a', '1I5ddNMpRBgiab0utJwjVGb0FeP9N7L70', '1_AfJDMMkUpPVQU5DSQ_J-Ho4vJEV1052', '1q31T5jfFCInTQQ2UePFemAOW54H7asmU',
  '1j3HcWJygFyTaG16f1qzEBeBUkJprP8PX', '1DjQhnyS32Tk90zfPL6q90r4W3NKnSFgH', '1Jn1R3RjAYcxDAGyRgo6XDEpqbi_mj9Re', '18xXTZYFMq24c1VOudEM49BjeHVALEl3I',
  '1-I-mnJG1XS-dgC6YEDYtKNnNS9PyRUng', '1vY5T56P6Vn9bK1RwGp0SfMKTiPSSHHt0', '1LpYrRwtbWzO9QOAi0t40Cv5vs1CVVXB6', '1xl5GbRk5WCoP_pt7pDYJNpnyemt9zZAV',
  '1g_QrRJ8qMtqMU9aw1BQJKqsexb9LBucn', '1uiUK1gMcLHl6hxtrVaam8CWF8Io9otS7', '1rEiC3H0sAA5UgHPf-Wl4i1hJvonVv7C_', '1xPEsUjBepleFTueF3tszt_Vabd8FOYJF',
  '14tSU1i-126zQ6GPY1OTcPYz6JccqvDj1', '1XFKrz8DBhvVPs9xhi3BqtUIlXGWfV78j', '1BAJ7vuzKiHdohJ85LfOuHgc7-KFHuwH3', '1mXUyvFmYZFam8-mbUxQoB4XLc8YMrpo4',
  '1yI4tnOUPjR3XFEt0OZUh5WI9iJRUFP3w', '1-_03fU6C0QQJxHuB4AQvoiBZAIAV7OTa', '1SXJxHonj6CVkBzxWiER6qXbe2ZLdQHmF', '1UAhFMHRLW6m6NA3OPCLLK4uV90CHkCyb',
  '1EbIzNqubmmhI-qo-OBI-AQ0HWRQ-I842', '1kYb77MZHIf-Jqx5azftEKAcJ_Yn5no4n', '19z2kiUkufG3LthMeW_LpqAiKcrlyVvAl', '1bM1zHypDkb7apCk3dxm7h1_BJqjBtyaT',
  '1B65q08aBL_6eBNbVQoBn33mWWGSn_MpP', '1Do3bCc7Ku0qpdx3zWVIYvjDSum7dnhy4', '13X5DSV5O8kL3dLjULYN3pUdNqtr0X_jK', '1uKSRV1slhyAbI6x6US35oIF19E2aPEOv',
  '1H1Co0iHtwnzNQ1RBonT8NdRHcfWWAGxy', '1ZIwQ1-TtgqRNOaDGKZJT1cTLeVzRdJYP', '1F6WtEIifeG0caX2B5TyF19veuXXQN12d', '12C6Knofsg4B_hgXcAD9UIsvO1KbS6zui',
  '1ErMUju4E093hcQa77ExGzmSsxi8eHUcV', '1zopJFgZW75mDXiiQdCjlhgL3FoPLdfoQ', '1RAK5kTOICrPmnfNazXZf5pF2UWtlcDtM', '1cP4vE4os-59gNWhY3mPitxy_v4j4IfZz',
  '165MSVKN3AFZRI-aQGFg1_ckMeOywNcb3', '1iZolCjUtzoA8zwWM4K0pncbsGbmkRAiR', '1clDi7ixDkVFXTcPix7BKjAdTyK01_S8Q', '1IjVL-a6wJHVJgwpej8pdIrdiVngGOMYf',
  '1A8zveSO7YdWUJCcA6KfiF4-O7xDeDK4R', '1wJDpHVdrl5NQXctkgxzZCAI6uGoFZQ1w', '1g41LTaRXa3jvkzQJYprQSRTLIq1v334t', '1LWgLU9meva8-DkTA7cuj4XkbXLr0ZDDw',
  '1sFwBKyCL9j721owuq_puUvGYKjDja1rL', '1WeI0amzFnsT1z-a_Ru5k9j6Bob4Mx23I', '180MeP1uwPI66QnYWmAQY8LrOTNwdWPMn', '1HrfSyAFIqVE3eeEP1OFADlBcuYA2BMAp',
  '1UC8vfCMCw3WVZYeYCr1_wgjeeGLAZ86G', '13UAzCYk7wGEVWseM65iXwrH8EUfXhQcH', '11Y6VXSMMN1p_xcbBsG6-NGLF33QIwzda', '1WjeAVOIgM-IsUJ0ktKqCqe9P0z1V0ES8',
  '1OgDXWEwKRYRxPBfO03SLeVdlNTyqX7X4', '1vfIB3yNYshmsfpDxPKxS3GqUtiDpZak3', '1zO6OGnH_yNy_ywwD-oY5qwD82BL8sC52', '1_v_273-ksGPc35GWPJz8CZev-4OoYoao',
  '1rqr3gRa1EtitYYIQ6NnSeg0V9QeIOIoD', '1BE3OyiQlj6nUN_xptHn1cgPB7GSqlpng', '1TPKH-bF6TL8sq2W4U_sDtl2wYTVA--fS', '1b0wuDFbimjUD1xeFiTVnH_8E36z_1Vpi',
  '1jT4IikaXAvMAcJtt8hCBr5lB-VuMoBkE', '1aBsHVP7XceTVsXtPB1JNvTXWjh4ZyIo1', '1Y-tH38aSWL5C0G_eO9BC6evk0gCRqh9Z', '1ryPgM3MVMbhAAWbRhZA_RaYxmXa3Z_VP',
  '1Uoav8RWOsVGDEL9rHObxbEkBdJdlTkAw', '1CsU2kGx3NOlcstAqj55QuybVr-yPmjBM', '1POagKunK-KRczZlBapm2sWh9oqQdgIGV', '1hXnTekW_LMPAkrOYAMvf5UEnxnZY2Wc1',
  '1GXt81zC-lJoY01OBkgKdQWqShLfmOs74', '1NiOr3enlhAHNxpQ5-lWPQ-0Yp8XbQ8QV', '1pPt58y459BT0djM_XTf-VeJhRlRC42Hl', '1blxLVC0EdDCSYat4MD-hULofpC3DqQD9',
  '1KHdXc01_ewKKbLZ3qgfC-GRRKUCuSJB8', '1qCJFLCTtV70FFX8NKfTYJyR0dF5uQBNW', '1E82TZLn8mq_6shEQ1whAhxK7yS-xvM98', '1XS-uywUQxFbQTjUanxiT_iAqlGJjH_4v',
  '1VwPX_L3K9X5PcejMEGw--RLV46zrZI2y', '1hYLWbZuLQx2hTDfwHAJ8M31F2WPbsKAc', '1juu7bu05QSbGzk9_sUgR6xOqoTPoIEmS', '1iaQCeiwJjCJwjbzQLJ-pRUqQzFwZCnXq',
  '1JjJMmWtfG2OK2f71qmd87hQHbwwD6WMl', '1sj1HZo4ZOnhgKJh4ZxEY7Fqfx6tR4fip', '12NN-2itElGM66TO2OsqVo_2oHhPcJJ6g', '18rSkBYQoHkGXIUYFNC2DNowtDqdwPSgW',
  '1FZceau55vqwA3rPkS3pVzMpHP3Yc3wX5', '1DOnoJUq8y-UWrlmOd5vwD2OviwYqh6k6', '1n-z02tpwl8jH2Q44KIfHAYfOfCBIqiLB', '1MVxR3LN3TKW3Xjva68g9v0eBxhqQE35O',
  '1AKjrrwfyyCpbbYHSlfoTtqWnaKLf1QBT', '13mq866zCtMHyKkKHjxP5CjADARMvnGAb', '1SIVJRZcbEZp8O2YuUveF_tzuh_kYN88i', '1bNPamEXOESZrHpLhRuKzERpL3glshxAs',
  '1PKV5paaL5EGtdkLRTYR3wDWL9GHI8D-h', '1uZa1pT8rvonW2YV0WWkK3aisjn4t9XRz', '1k1NUuVhSeLoawQ2V3oalEbj5xXT-xr0X'
];

var NAGLOWKI = ['file_id', 'status', 'nazwa', 'w_koszu', 'md5', 'rozmiar',
                'typ', 'zmodyfikowany', 'wlasciciel', 'szczegoly'];

var _wersja = null;
function wersja_() {
  if (_wersja) return _wersja;
  if (typeof Drive === 'undefined') throw new Error('Dodaj usługę Drive API (Usługi + → Drive API).');
  try { Drive.Files.list({ pageSize: 1, fields: 'files(id)' }); _wersja = 3; }
  catch (e) { _wersja = 2; }
  return _wersja;
}

function audytZaginionych() {
  var ss = SpreadsheetApp.getActive();
  var ark = ss.getSheetByName(ARKUSZ);
  if (!ark) { ark = ss.insertSheet(ARKUSZ); ark.appendRow(NAGLOWKI); ark.setFrozenRows(1); }

  var props = PropertiesService.getDocumentProperties();
  var i = Number(props.getProperty(KLUCZ) || 0);
  if (i >= IDENTYFIKATORY.length) {
    Logger.log('Gotowe — sprawdzono wszystkie ' + IDENTYFIKATORY.length + '. Reset: resetAudytu().');
    return;
  }

  var t0 = new Date().getTime();
  var bufor = [];
  for (; i < IDENTYFIKATORY.length; i++) {
    if (new Date().getTime() - t0 > LIMIT_MS) break;
    bufor.push(sprawdz_(IDENTYFIKATORY[i]));
    if (bufor.length >= 50) {
      ark.getRange(ark.getLastRow() + 1, 1, bufor.length, NAGLOWKI.length).setValues(bufor);
      bufor = []; props.setProperty(KLUCZ, String(i + 1));
    }
  }
  if (bufor.length) ark.getRange(ark.getLastRow() + 1, 1, bufor.length, NAGLOWKI.length).setValues(bufor);
  props.setProperty(KLUCZ, String(i));
  Logger.log('Sprawdzono ' + i + ' z ' + IDENTYFIKATORY.length
    + (i < IDENTYFIKATORY.length ? '. Uruchom ponownie.' : '. GOTOWE — pobierz zakładkę „wynik" jako CSV.'));
}

function sprawdz_(id) {
  try {
    var f = (wersja_() === 3)
      ? Drive.Files.get(id, { fields: 'id,name,md5Checksum,size,mimeType,modifiedTime,trashed,owners(emailAddress)', supportsAllDrives: true })
      : Drive.Files.get(id, { supportsAllDrives: true });
    var wKoszu = (f.trashed || f.labels && f.labels.trashed) ? 'tak' : 'nie';
    return [id, 'ok', f.name || f.title || '', wKoszu, f.md5Checksum || '',
            f.size || f.fileSize || '', f.mimeType || '',
            f.modifiedTime || f.modifiedDate || '',
            (f.owners && f.owners[0] && f.owners[0].emailAddress) || '', ''];
  } catch (e) {
    var m = String(e.message || e);
    var st = (m.indexOf('404') > -1 || /not found/i.test(m)) ? 'brak-pliku'
           : (m.indexOf('403') > -1) ? 'brak-dostepu' : 'blad';
    return [id, st, '', '', '', '', '', '', '', m.slice(0, 150)];
  }
}

function resetAudytu() {
  PropertiesService.getDocumentProperties().deleteProperty(KLUCZ);
  Logger.log('Kursor wyzerowany (zakładkę „wynik" usuń ręcznie, jeśli chcesz zacząć czysto).');
}

function postepAudytu() {
  var z = Number(PropertiesService.getDocumentProperties().getProperty(KLUCZ) || 0);
  Logger.log(z + ' / ' + IDENTYFIKATORY.length);
}
