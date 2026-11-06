# Cash drawer shifts

A shift is one stretch of work with one cash drawer (for example, one day). You count the cash when you start, and count it again when you finish.
The app tells you what *should* be in the drawer, so you can see if you are short or over.

## What you do
1. **Open shift** and type the cash you are starting with (count the bills and coins; 0 if empty).
2. Sell as usual. Nothing changes on the Sell screen.
3. If you add cash (change from the bank) or take cash out (paying a supplier), press **Cash in** or **Cash out** and write what it was for.
4. At the end press **Close shift**, count the drawer and type the total. The app says *Balanced*, *Short by* or *Over by*.
   If it is not balanced you must write a note that explains it. A report can be printed.

## How "should be in the drawer" is worked out
`starting cash + cash received − cash refunded + cash put in − cash taken out`

- *Cash* means a payment method with "cash" in its name (the same rule the Sell screen uses for the change box). E-wallet, card and so on are listed separately and are not counted in the drawer.
- Cash received = every cash payment recorded while the shift was open, including money collected later on a pay-later sale.
  A sale entered with an earlier date (back-dated) is not counted, because that cash was not put in this drawer during this shift.
- Cash refunded = refunds paid in cash for returns processed while the shift was open.
- If a cash sale is voided later, the money did come into the drawer, so it is still counted. If you gave the cash back, record it as **Cash out**. The screen shows a note when this happens.
- A closed shift is saved as a snapshot and never changes afterwards.

## Rules
- Only one shift can be open at a time (one shared drawer). Opening or closing twice by accident is safe.
- Owner, manager and cashier can open, close and move cash. The accountant can only look.
- Cashiers see only the shifts they opened or closed. Owner, manager and accountant see all.
- Every open, cash in/out and close is written to the audit log.
- Selling never depends on a shift. The drawer is a cash check only; it does not change sales, returns, dashboard or tax figures.

## Not yet
Several drawers at the same time, bank deposits, and a count by bill and coin value.
