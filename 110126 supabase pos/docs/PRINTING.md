# Receipt printing and receipt printers

## What the app does now
- The receipt is printed on a **fixed paper width** (58 mm or 80 mm roll) and is **centred**. Choose the paper in **Settings → Receipt printer (this device)** or in the receipt window.
- The page is made **exactly as tall as the receipt**, so every item fits on one strip with no blank paper. 40 items, long product names and big amounts were all tested.
- **Settings → Print test receipt** prints a sample so you can check a new printer without making a sale.
- "A4 / Letter sheet" still exists for a normal printer (receipt centred on the sheet).
- Not a BIR-approved official receipt. Check with your BIR office or accountant what your shop needs.

## How it connects (the three ways)
A receipt printer is just a printer. The app asks the **browser** to print, and the browser sends it to whatever printer the device knows.

| Printer type | How to connect | Works with the app |
|---|---|---|
| **USB** (cable to a Windows PC or laptop) | Install the maker's driver (Epson, Xprinter, Rongta, POS-80, etc.). It shows up as a normal printer. | Yes: Print receipt, choose the printer. |
| **LAN / WiFi** (network cable or wifi) | Give it an IP address, add it in Windows as a printer (or the maker's tool), install the driver. | Yes, same as USB. |
| **Bluetooth** (phones, tablets) | Pair it in the tablet's Bluetooth settings. Android Chrome cannot print straight to most Bluetooth thermal printers, so use a free "print service" app (for example RawBT or the printer maker's app). | Likely, **not tested here**. See below. |
| iPad / iPhone | Needs an AirPrint printer. Most cheap thermal printers do not support it. | Only with AirPrint models. |

## Windows PC, step by step (USB or LAN)
1. Plug in the printer, install its driver, and check it prints a Windows test page.
2. Windows → Settings → Printers: open the printer → **Printing preferences** → set the paper to the roll size (for example "80mm x Roll" or "80 x 297"). Choose the cutter option if it has one.
3. In the POS: **Settings → Receipt printer** → choose the same paper → **Print test receipt**.
4. In Chrome's print window: Destination = your receipt printer, **Margins = None**, **Headers and footers = off**, Scale = 100. Chrome remembers these.
5. Check the test receipt: centred, nothing cut off at the sides.

### Print with ONE click (no print window)
Make the receipt printer the Windows **default printer**. Then make a shortcut to Chrome whose Target ends with:
`--kiosk-printing --app=https://YOUR-SITE.netlify.app`
Now **Print receipt** goes straight to the printer. (Use this shortcut only on the counter PC.)

## Android tablet with a Bluetooth printer
1. Pair the printer in Bluetooth settings.
2. Install RawBT (or the printer maker's app) and set the printer there. Make the paper size match (58 or 80 mm).
3. In the POS press Print receipt and choose that app/printer in Android's print list.
4. If it prints but the layout is odd, tell me the printer model: the next step would be sending the receipt to the printer in its own language (ESC/POS) over Web Bluetooth or USB. That only works in Chrome/Edge (not iPad), and needs a real printer to test, so I have **not** built it yet.

## If something looks wrong
| Problem | Fix |
|---|---|
| Receipt is small and on one side | The driver paper size is a normal sheet. Change it to the roll size in Printing preferences. |
| Long blank paper after the receipt | The driver's paper has a fixed long length. Choose "Roll" / "continuous" paper. |
| Edges are cut | Set Margins = None. If still cut, choose 58 mm or the 80 mm option your driver calls "72 mm printable". |
| Letters too small | Pick 58 mm paper only if your roll is 58 mm; a 80 mm roll should use 80. |
| Two receipts print | Press Print once; check the browser did not also open a duplicate tab. |

## Tests
`node tests-browser/print.cjs` prints receipts to PDF with the browser's own engine (58 and 80 mm, 2 to 40 items, long names) and checks: one strip, correct width, centred, as tall as needed.
`node tests-browser/responsive.cjs` opens every screen on 7 screen sizes (320 px phone up to 1920 px) and checks nothing scrolls sideways or crashes.
