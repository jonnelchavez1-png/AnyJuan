import { createContext, useContext } from 'react';

export const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

/** What each role may do. The database enforces the same rules; this only hides buttons people cannot use. */
export const CAN = {
  sell: ['owner', 'manager', 'cashier'],
  viewSales: ['owner', 'manager', 'cashier', 'accountant'],
  voidSale: ['owner', 'manager'],
  returnItems: ['owner', 'manager'],
  takePayment: ['owner', 'manager', 'cashier'],
  editProducts: ['owner', 'manager'],
  adjustStock: ['owner', 'manager'],
  viewExpenses: ['owner', 'manager', 'accountant'],
  editExpenses: ['owner', 'manager', 'accountant'],
  viewDashboard: ['owner', 'manager', 'accountant'],
  editLists: ['owner', 'manager'],
  editBusiness: ['owner'],
  manageStaff: ['owner'],
};
