import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import Header from './components/layout/Header';
import HomePage from './routes/HomePage';
import ItemsPage from './routes/ItemsPage';
import ItemDetailPage from './routes/ItemDetailPage';
import FluidsPage from './routes/FluidsPage';
import FluidDetailPage from './routes/FluidDetailPage';
import MaterialsPage from './routes/MaterialsPage';
import MaterialDetailPage from './routes/MaterialDetailPage';
import RecipeSearchPage from './routes/RecipeSearchPage';

const routerBasename = import.meta.env.BASE_URL.replace(/\/$/, '') || '/';

function App() {
  return (
    <Router basename={routerBasename}>
      <div className="min-h-screen bg-gray-900">
        <Header />
        <main className="container mx-auto px-6 py-8">
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/items" element={<ItemsPage />} />
            <Route path="/items/:resource/:damage" element={<ItemDetailPage />} />
            <Route path="/fluids" element={<FluidsPage />} />
            <Route path="/fluids/:unlocalizedName" element={<FluidDetailPage />} />
            <Route path="/materials" element={<MaterialsPage />} />
            <Route path="/materials/:unlocalizedName" element={<MaterialDetailPage />} />
            <Route path="/recipes" element={<RecipeSearchPage />} />
          </Routes>
        </main>
        <footer className="border-t border-gray-800 py-6 mt-8">
          <div className="container mx-auto px-6 flex items-center justify-center gap-6 text-sm text-gray-500">
            <a
              href="https://www.curseforge.com/minecraft/modpacks/supersymmetry"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-cyan-400 transition"
            >
              Download Supersymmetry! (CurseForge)
            </a>
            <span className="text-gray-700">|</span>
            <a
              href="https://github.com/SymmetricDevs/RecipeViewer"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-cyan-400 transition"
            >
              Website Source (GitHub)
            </a>
          </div>
        </footer>
      </div>
    </Router>
  );
}

export default App;
